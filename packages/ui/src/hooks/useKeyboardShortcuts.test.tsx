import { expect, test } from 'bun:test';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { opencodeClient } from '@/lib/opencode/client';
import { useInputStore } from '@/sync/input-store';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

test('Ctrl+L adds a selection outside chat and yields to a sequence without one', async () => {
  const dom = new Window({ url: 'http://shortcut.test' });
  const directory = '/workspace/shortcut-test';
  const fetchResponse = async (request: Request | URL | string) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const data = path.endsWith('/location')
      ? { directory, project: { id: 'project', directory, canonical: directory } }
      : path.endsWith('/vcs') ? { data: { branch: { current: 'main', default: 'main' } } }
      : path.endsWith('/session/active') ? { data: {} }
      : path.endsWith('/config') || path.endsWith('/project') ? [] : { data: [] };
    return Response.json(data);
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement, Node: dom.Node, Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetchResponse,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  opencodeClient.reconnectToRuntimeBaseUrl();
  const sdk = OpenCode.make({
    baseUrl: 'https://shortcut.test',
    fetch: fetchResponse,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const previousOverrides = useUIStore.getState().shortcutOverrides;
  const textarea = document.createElement('textarea');
  textarea.value = 'alpha beta gamma';
  document.body.append(textarea);
  const chatInput = document.createElement('div');
  chatInput.dataset.chatInput = 'true';
  const composer = document.createElement('div');
  composer.className = 'cm-content';
  composer.tabIndex = 0;
  chatInput.append(composer);
  document.body.append(chatInput);

  function ShortcutOwner() {
    useKeyboardShortcuts();
    return null;
  }

  try {
    await act(async () => root.render(
      <ThemeSystemProvider>
        <SyncProvider sdk={sdk} directory={directory}><ShortcutOwner /></SyncProvider>
      </ThemeSystemProvider>,
    ));

    textarea.focus();
    textarea.setSelectionRange(6, 10);
    const selectedKey = new KeyboardEvent('keydown', {
      key: 'l', code: 'KeyL', ctrlKey: true, bubbles: true, cancelable: true,
    });
    await act(async () => { textarea.dispatchEvent(selectedKey); await Promise.resolve(); });

    expect(selectedKey.defaultPrevented).toBe(true);
    expect(useInputStore.getState()).toMatchObject({
      pendingInputText: '```md\nbeta\n```', pendingInputMode: 'append',
    });
    expect(document.activeElement).toBe(composer);
    expect(textarea.selectionStart).toBe(textarea.selectionEnd);

    useInputStore.getState().setPendingInputText(null);
    useUIStore.setState({ shortcutOverrides: { ...previousOverrides, focus_input: 'mod+l i' } });
    textarea.focus();
    const leader = new KeyboardEvent('keydown', {
      key: 'l', code: 'KeyL', ctrlKey: true, bubbles: true, cancelable: true,
    });
    await act(async () => { textarea.dispatchEvent(leader); await Promise.resolve(); });

    expect(leader.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);
    expect(useInputStore.getState().pendingInputText).toBeNull();

    const completion = new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', bubbles: true, cancelable: true });
    await act(async () => { textarea.dispatchEvent(completion); });
    expect(completion.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(composer);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ shortcutOverrides: previousOverrides });
    useInputStore.getState().setPendingInputText(null);
    host.remove();
    textarea.remove();
    chatInput.remove();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    opencodeClient.reconnectToRuntimeBaseUrl();
    await dom.happyDOM.close();
  }
});
