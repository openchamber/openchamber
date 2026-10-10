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

const directory = '/workspace/shortcut-test';

async function withShortcutsMounted(run: (requests: string[]) => Promise<void>) {
  const dom = new Window({ url: 'http://shortcut.test' });
  const requests: string[] = [];
  const fetchResponse = async (request: Request | URL | string) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    requests.push(path);
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
    await run(requests);
  } finally {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    opencodeClient.reconnectToRuntimeBaseUrl();
    await dom.happyDOM.close();
  }
}

function createComposer(parent: HTMLElement) {
  const chatInput = document.createElement('div');
  chatInput.dataset.chatInput = 'true';
  const composer = document.createElement('div');
  composer.className = 'cm-content';
  composer.tabIndex = 0;
  chatInput.append(composer);
  parent.append(chatInput);
  return composer;
}

test('Ctrl+L adds a selection outside chat and yields to a sequence without one', async () => {
  const previousOverrides = useUIStore.getState().shortcutOverrides;
  await withShortcutsMounted(async () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'alpha beta gamma';
    document.body.append(textarea);
    const composer = createComposer(document.body);

    try {
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
      useUIStore.setState({ shortcutOverrides: previousOverrides });
      useInputStore.getState().setPendingInputText(null);
    }
  });
});

test('double Escape stops a running chat only from its composer', async () => {
  await withShortcutsMounted(async (requests) => {
    const column = document.createElement('div');
    column.dataset.chatColumn = 'pinned';
    column.dataset.chatSessionId = 'ses_pinned';
    column.dataset.chatWorking = 'true';
    document.body.append(column);
    const composer = createComposer(column);
    // A button in the same chat, standing in for a panel or toolbar control.
    const panelButton = document.createElement('button');
    column.append(panelButton);
    // An Escape the composer spends on itself, such as closing a picker.
    let composerConsumesEscape = false;
    composer.addEventListener('keydown', (event) => {
      if (composerConsumesEscape) event.preventDefault();
    });

    const pressEscape = async (target: HTMLElement) => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => { target.dispatchEvent(event); await Promise.resolve(); });
      return event;
    };
    const aborts = () => requests.filter((path) => path.includes('ses_pinned')).length;

    await pressEscape(panelButton);
    await pressEscape(panelButton);
    expect(aborts()).toBe(0);

    await pressEscape(composer);
    await pressEscape(panelButton);
    await pressEscape(composer);
    expect(aborts()).toBe(0);

    composerConsumesEscape = true;
    await pressEscape(composer);
    composerConsumesEscape = false;
    expect((await pressEscape(composer)).defaultPrevented).toBe(true);
    expect(aborts()).toBe(0);

    expect((await pressEscape(composer)).defaultPrevented).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(aborts()).toBe(1);
  });
});
