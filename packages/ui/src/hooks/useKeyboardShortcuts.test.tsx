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
import { useSettingsKeyboardShortcuts } from './useSettingsKeyboardShortcuts';

const directory = '/workspace/shortcut-test';

test('web terminal zoom handles configured shortcuts only while focused', async () => {
  const previousOverrides = useUIStore.getState().shortcutOverrides;
  try {
    useUIStore.setState({ shortcutOverrides: {} });
    await withShortcutsMounted(async () => {
      const terminal = document.createElement('div');
      terminal.dataset.terminalOwner = 'main';
      const input = document.createElement('textarea');
      terminal.append(input);
      document.body.append(terminal);
      const actions: string[] = [];
      window.addEventListener('openchamber:zoom', (event) => {
        if (event instanceof CustomEvent) actions.push(event.detail);
      });
      const press = (target: HTMLElement, key: string, code: string) => {
        const event = new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      // The terminal surface encodes keyups it receives as Kitty release
      // events, so a consumed zoom press must not leak its release there.
      const releases: string[] = [];
      input.addEventListener('keyup', (event) => releases.push(event.code));
      const release = (code: string) => input.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
      input.focus();
      expect(press(input, '=', 'Equal')).toBe(true);
      release('Equal');
      expect(press(input, '-', 'Minus')).toBe(true);
      release('Minus');
      expect(press(input, '0', 'Digit0')).toBe(true);
      release('Digit0');
      expect(actions).toEqual(['zoom-in', 'zoom-out', 'zoom-reset']);
      expect(releases).toEqual([]);
      release('KeyA');
      expect(releases).toEqual(['KeyA']);
      useUIStore.setState({ shortcutOverrides: { zoom_in: 'mod+shift+y' } });
      expect(press(input, '=', 'Equal')).toBe(false);
      release('Equal');
      expect(releases).toEqual(['KeyA', 'Equal']);
      const rebound = new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(rebound);
      expect(rebound.defaultPrevented).toBe(true);
      release('KeyY');
      expect(releases).toEqual(['KeyA', 'Equal']);
      expect(actions.at(-1)).toBe('zoom-in');
      useUIStore.setState({ shortcutOverrides: { toggle_terminal: 'mod+minus' } });
      expect(press(input, '-', 'Minus')).toBe(true);
      expect(actions).toHaveLength(4);
      useUIStore.setState({ shortcutOverrides: {} });
      const other = document.createElement('input');
      document.body.append(other);
      other.focus();
      expect(press(other, '-', 'Minus')).toBe(false);
      terminal.dataset.terminalOwner = 'surface:guest';
      input.focus();
      expect(press(input, '-', 'Minus')).toBe(false);
      terminal.dataset.terminalOwner = 'main';
      window.__OPENCHAMBER_SURFACE__ = 'mobile';
      input.focus();
      expect(press(input, '=', 'Equal')).toBe(false);
      expect(press(input, '-', 'Minus')).toBe(false);
      expect(press(input, '0', 'Digit0')).toBe(false);
      window.__OPENCHAMBER_SURFACE__ = undefined;
      Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
      input.focus();
      expect(press(input, '-', 'Minus')).toBe(false);
      expect(actions).toHaveLength(4);
    });
  } finally {
    useUIStore.setState({ shortcutOverrides: previousOverrides });
  }
});

async function withShortcutsMounted(
  run: (requests: string[], waitForRequest: (pathFragment: string) => Promise<void>) => Promise<void>,
  settingsOnly = false,
) {
  const dom = new Window({ url: 'http://shortcut.test' });
  const requests: string[] = [];
  const requestListeners = new Map<string, () => void>();
  const waitForRequest = (pathFragment: string) => new Promise<void>((resolve) => {
    requestListeners.set(pathFragment, resolve);
  });
  const fetchResponse = async (request: Request | URL | string) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    requests.push(path);
    for (const [fragment, resolve] of requestListeners) {
      if (path.includes(fragment)) {
        requestListeners.delete(fragment);
        resolve();
      }
    }
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

  function SettingsShortcutOwner() {
    useSettingsKeyboardShortcuts();
    return null;
  }

  try {
    await act(async () => root.render(
      <ThemeSystemProvider>
        {settingsOnly ? <SettingsShortcutOwner /> : (
          <SyncProvider sdk={sdk} directory={directory}><ShortcutOwner /></SyncProvider>
        )}
      </ThemeSystemProvider>,
    ));
    await run(requests, waitForRequest);
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

test('Settings shortcuts work without a chat sync owner or session requests', async () => {
  const previousUI = useUIStore.getState();
  try {
    useUIStore.setState({ isSettingsDialogOpen: true, shortcutOverrides: { open_settings: 'mod+k s' } });
    await withShortcutsMounted(async (requests) => {
      const input = document.createElement('input');
      document.body.append(input);
      input.focus();
      const press = async (key: string, code: string, ctrlKey = false) => {
        const event = new KeyboardEvent('keydown', { key, code, ctrlKey, bubbles: true, cancelable: true });
        await act(async () => { input.dispatchEvent(event); });
        return event;
      };
      expect((await press('n', 'KeyN', true)).defaultPrevented).toBe(false);
      expect((await press('k', 'KeyK', true)).defaultPrevented).toBe(true);
      expect((await press('s', 'KeyS')).defaultPrevented).toBe(true);
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
      expect(requests).toEqual([]);
    }, true);
  } finally {
    useUIStore.setState(previousUI, true);
  }
});

test('Settings yields its default VS Code key and lets inputs and menus use Escape first', async () => {
  const previousUI = useUIStore.getState();
  try {
    useUIStore.setState({ isSettingsDialogOpen: true, shortcutOverrides: {} });
    await withShortcutsMounted(async () => {
      Object.assign(window, { __VSCODE_CONFIG__: { panelType: 'settings' } });
      const input = document.createElement('input');
      document.body.append(input);
      const press = async (key: string, options: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
        await act(async () => { input.dispatchEvent(event); });
        return event;
      };
      expect((await press(',', { code: 'Comma', ctrlKey: true })).defaultPrevented).toBe(false);
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
      await press('Escape', { isComposing: true });
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);

      const menu = document.createElement('div');
      menu.dataset.slot = 'select-content';
      menu.dataset.open = '';
      document.body.append(menu);
      await press('Escape');
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
      menu.remove();

      const consume = (event: KeyboardEvent) => event.preventDefault();
      input.addEventListener('keydown', consume);
      await press('Escape');
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
      input.removeEventListener('keydown', consume);
      expect((await press('Escape')).defaultPrevented).toBe(true);
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    }, true);
  } finally {
    useUIStore.setState(previousUI, true);
  }
});

test('Escape on a fullscreen diagram control over Settings leaves Settings open', async () => {
  const previousUI = useUIStore.getState();
  try {
    useUIStore.setState({ isSettingsDialogOpen: true, isImagePreviewOpen: true });
    await withShortcutsMounted(async () => {
      // The viewer's toolbar is portaled to the body, outside Settings' dialog.
      const zoom = document.createElement('button');
      document.body.append(zoom);
      const press = async () => {
        await act(async () => {
          zoom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
      };
      await press();
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
      useUIStore.setState({ isImagePreviewOpen: false });
      await press();
      expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
    });
  } finally {
    useUIStore.setState(previousUI, true);
  }
});

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
  await withShortcutsMounted(async (requests, waitForRequest) => {
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

    const interrupted = waitForRequest('ses_pinned');
    expect((await pressEscape(composer)).defaultPrevented).toBe(true);
    await act(async () => { await interrupted; });
    expect(aborts()).toBe(1);
  });
});

test('a chord started in a field that is gone completes unless another field is pressed', async () => {
  const previous = useUIStore.getState().shortcutOverrides;
  try {
    useUIStore.setState({ shortcutOverrides: {}, isHelpDialogOpen: false });
    await withShortcutsMounted(async () => {
      const composer = document.createElement('textarea');
      document.body.append(composer);
      const startInPalette = () => {
        const palette = document.createElement('input');
        document.body.append(palette);
        palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
        palette.remove();
      };
      const typeH = async () => {
        await act(async () => {
          composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true, cancelable: true }));
        });
        return useUIStore.getState().isHelpDialogOpen;
      };
      startInPalette();
      composer.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(await typeH()).toBe(false);
      startInPalette();
      expect(await typeH()).toBe(true);
    });
  } finally {
    useUIStore.setState({ shortcutOverrides: previous, isHelpDialogOpen: false });
  }
});
