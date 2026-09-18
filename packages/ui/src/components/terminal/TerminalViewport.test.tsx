import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { toast } from 'sonner';

import { I18nProvider } from '@/lib/i18n';
import { useTerminalStore, type TerminalChunk } from '@/stores/useTerminalStore';

import type { TerminalSurface, TerminalSurfaceFactory } from './TerminalViewport';

// Base UI determines DOM availability when its modules load.
const initialWindow = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: initialWindow, document: initialWindow.document });
const { TerminalViewport } = await import('./TerminalViewport');

type TerminalEvent =
  | { type: 'write'; data: string }
  | { type: 'reset'; data: string; size?: { cols: number; rows: number } }
  | { type: 'visible'; visible: boolean }
  | { type: 'paste'; data: string }
  | { type: 'dispose' };
const terminalEvents: TerminalEvent[] = [];
let selectedText = '';
let reportMouse = false;
let focusCount = 0;

class TerminalSurfaceDouble implements TerminalSurface {
  write(data: string) {
    terminalEvents.push({ type: 'write', data });
  }
  resetAndWrite(data: string, drawnSize?: { readonly cols: number; readonly rows: number }) {
    const event: TerminalEvent = { type: 'reset', data };
    if (drawnSize) event.size = { cols: drawnSize.cols, rows: drawnSize.rows };
    terminalEvents.push(event);
  }
  setTheme() {}
  setFont() {
    return Promise.resolve();
  }
  setVisible(visible: boolean) {
    terminalEvents.push({ type: 'visible', visible });
  }
  fit() {
    return true;
  }
  refresh() {}
  focus() { focusCount += 1; }
  getSelection() {
    return selectedText;
  }
  async pasteFromClipboard(readText: () => Promise<string>, isCurrent: () => boolean = () => true) {
    const data = await readText();
    if (isCurrent()) terminalEvents.push({ type: 'paste', data });
  }
  getSelectionPosition() {
    return null;
  }
  scrollLines() {}
  selectWordAt() {
    return false;
  }
  extendSelectionTo() {}
  dispose() {
    terminalEvents.push({ type: 'dispose' });
  }
}

const createSurface: TerminalSurfaceFactory = (mount, options) => {
  const canvas = document.createElement('canvas');
  canvas.addEventListener('contextmenu', (event) => {
    if (reportMouse && !event.shiftKey) event.preventDefault();
    else options.onContextMenu?.(event);
  });
  mount.appendChild(canvas);
  return Promise.resolve(new TerminalSurfaceDouble());
};

const theme = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: '#334155',
  selectionForeground: '#ffffff',
  black: '#111111',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  white: '#ffffff',
  brightBlack: '#666666',
  brightRed: '#ff0000',
  brightGreen: '#00ff00',
  brightYellow: '#ffff00',
  brightBlue: '#0000ff',
  brightMagenta: '#ff00ff',
  brightCyan: '#00ffff',
  brightWhite: '#ffffff',
} as const;

const flushSurfaceLoad = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const TERMINAL_BUFFER_CAP = 512 * 1024;

const buildReplacedBufferChunks = (content: string): TerminalChunk[] => {
  const directory = '/fixture';
  useTerminalStore.getState().clearAll();
  useTerminalStore.getState().ensureDirectory(directory);
  const tabId = useTerminalStore.getState().getDirectoryState(directory)?.tabs[0]?.id;
  if (!tabId) throw new Error('fixture tab missing');
  useTerminalStore.getState().replaceBuffer(directory, tabId, content, 1);
  return [...useTerminalStore.getState().getBuffer(directory, tabId).chunks];
};

const renderViewport = (root: Root, chunks: TerminalChunk[], isVisible = true, sessionKey = 'session-1', enableTouchScroll = false) => act(async () => {
  root.render(
    <I18nProvider>
      <TerminalViewport
        sessionKey={sessionKey}
        chunks={chunks}
        onInput={() => undefined}
        onResize={() => undefined}
        theme={theme}
        monoFont="system-mono"
        fontFamily="Menlo"
        fontSize={14}
        isVisible={isVisible}
        enableTouchScroll={enableTouchScroll}
        createSurface={createSurface}
      />
    </I18nProvider>,
  );
});

describe('TerminalViewport integration', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    terminalEvents.length = 0;
    selectedText = '';
    reportMouse = false;
    focusCount = 0;
    useTerminalStore.getState().clearAll();
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      KeyboardEvent: windowInstance.KeyboardEvent,
      DOMRect: windowInstance.DOMRect,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useTerminalStore.getState().clearAll();
  });

  const openContextMenu = async (shiftKey = false) => {
    const canvas = host.querySelector('canvas');
    if (!canvas) throw new Error('terminal canvas missing');
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30, shiftKey,
      }));
    });
  };

  const menuItem = (label: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((element) => element.textContent === label);
    if (!item) throw new Error(`menu item missing: ${label}`);
    return item;
  };

  test('opens Copy/Paste on a surface-approved right click and copies the selected output', async () => {
    selectedText = 'terminal output\n';
    await renderViewport(root, []);
    await flushSurfaceLoad();
    await openContextMenu();
    expect(menuItem('Paste')).toBeDefined();
    await act(async () => menuItem('Copy').click());
    expect(await navigator.clipboard.readText()).toBe('terminal output\n');
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    expect(terminalEvents.filter((event) => event.type === 'dispose')).toHaveLength(0);
  });

  test('supports arrow and Ctrl+N/P menu navigation and returns focus on Escape', async () => {
    selectedText = 'selection';
    await renderViewport(root, []);
    await flushSurfaceLoad();
    await openContextMenu();
    await act(async () => menuItem('Copy').focus());
    const press = async (key: string, ctrlKey = false) => {
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key, ctrlKey, bubbles: true, cancelable: true,
      })));
    };
    await press('ArrowDown');
    expect(document.activeElement).toBe(menuItem('Paste'));
    await press('ArrowUp');
    expect(document.activeElement).toBe(menuItem('Copy'));
    await press('n', true);
    expect(document.activeElement).toBe(menuItem('Paste'));
    await press('p', true);
    expect(document.activeElement).toBe(menuItem('Copy'));
    const beforeClose = focusCount;
    await press('Escape');
    expect(focusCount).toBeGreaterThan(beforeClose);
  });

  test('disables Copy without a selection and pastes through the terminal surface', async () => {
    await navigator.clipboard.writeText('echo hello\n');
    await renderViewport(root, []);
    await flushSurfaceLoad();
    await openContextMenu();
    expect(menuItem('Copy').getAttribute('aria-disabled')).toBe('true');
    await act(async () => menuItem('Paste').click());
    expect(terminalEvents.filter((event) => event.type === 'paste')).toEqual([
      { type: 'paste', data: 'echo hello\n' },
    ]);
  });

  test('leaves application-owned right clicks alone and permits the surface Shift override', async () => {
    reportMouse = true;
    await renderViewport(root, []);
    await flushSurfaceLoad();
    await openContextMenu();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await openContextMenu(true);
    expect(menuItem('Paste')).toBeDefined();
  });

  test('keeps the desktop menu out of touch-owned terminals', async () => {
    await renderViewport(root, [], true, 'session-1', true);
    await flushSurfaceLoad();
    await openContextMenu();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  test('drops a pending clipboard read when the terminal session changes', async () => {
    let finishRead: (text: string) => void = () => { throw new Error('read not started'); };
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () => new Promise<string>((resolve) => { finishRead = resolve; }),
    });
    await renderViewport(root, []);
    await flushSurfaceLoad();
    await openContextMenu();
    await act(async () => menuItem('Paste').click());
    await renderViewport(root, [], true, 'session-2');
    await act(async () => finishRead('must not reach the new session'));
    expect(terminalEvents.filter((event) => event.type === 'paste')).toHaveLength(0);
  });

  test('reports denied clipboard access without sending terminal input', async () => {
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () => Promise.reject(new Error('Clipboard access denied')),
    });
    await renderViewport(root, []);
    await flushSurfaceLoad();
    await openContextMenu();
    await act(async () => menuItem('Paste').click());
    expect(terminalEvents.filter((event) => event.type === 'paste')).toHaveLength(0);
    expect(toast.getHistory().some((entry) => 'title' in entry
      && entry.title === 'Could not read the clipboard. Use the paste keyboard shortcut.')).toBe(true);
  });

  test('drops a pending clipboard read even if the terminal is hidden and shown again', async () => {
    let finishRead: (text: string) => void = () => { throw new Error('read not started'); };
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () => new Promise<string>((resolve) => { finishRead = resolve; }),
    });
    await renderViewport(root, []);
    await flushSurfaceLoad();
    await openContextMenu();
    await act(async () => menuItem('Paste').click());
    await renderViewport(root, [], false);
    await renderViewport(root, [], true);
    await act(async () => finishRead('stale clipboard'));
    expect(terminalEvents.filter((event) => event.type === 'paste')).toHaveLength(0);
  });

  test('replays adopted history as one reset and keeps the capped buffer payload intact', async () => {
    const replayChunks: TerminalChunk[] = [
      { id: 1, data: 'live-one\n', replayData: 'replay-one\n', byteLength: 9 },
      { id: 2, data: 'live-two\n', replayData: 'replay-two\n', byteLength: 9 },
      { id: 3, data: 'live-three\n', byteLength: 11 },
    ];

    await renderViewport(root, replayChunks);
    await flushSurfaceLoad();

    expect(terminalEvents.filter((event) => event.type === 'reset' || event.type === 'write')).toEqual([
      { type: 'reset', data: 'replay-one\n' },
      { type: 'write', data: 'replay-two\nlive-three\n' },
    ]);

    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    terminalEvents.length = 0;

    const oversizedReplayChunks = buildReplacedBufferChunks(`${'🙂'.repeat(180_000)}tail`);
    const oversizedPayload = oversizedReplayChunks.map((chunk) => chunk.data).join('');

    await renderViewport(root, oversizedReplayChunks);
    await flushSurfaceLoad();

    expect(terminalEvents.filter((event) => event.type === 'reset')).toEqual([{ type: 'reset', data: oversizedPayload }]);
    expect(new TextEncoder().encode(oversizedPayload).byteLength).toBeLessThanOrEqual(TERMINAL_BUFFER_CAP);
  });

  test('appends live chunks and replaces history with a single reset', async () => {
    const initialChunks: TerminalChunk[] = [
      { id: 1, data: 'initial-live\n', replayData: 'initial-replay\n', byteLength: 13 },
    ];
    const appendedChunks: TerminalChunk[] = [
      ...initialChunks,
      { id: 2, data: 'append-live\n', replayData: 'append-replay\n', byteLength: 12 },
    ];
    const replacementChunks: TerminalChunk[] = [
      { id: 3, data: 'history-live-1\n', replayData: 'history-replay-1\n', byteLength: 15 },
      { id: 4, data: 'history-live-2\n', replayData: 'history-replay-2\n', byteLength: 15 },
    ];

    await renderViewport(root, initialChunks);
    await flushSurfaceLoad();
    terminalEvents.length = 0;

    await renderViewport(root, appendedChunks);
    expect(terminalEvents).toEqual([{ type: 'write', data: 'append-live\n' }]);

    terminalEvents.length = 0;
    await renderViewport(root, replacementChunks);
    expect(terminalEvents).toEqual([
      { type: 'reset', data: 'history-replay-1\n' },
      { type: 'write', data: 'history-replay-2\n' },
    ]);

    terminalEvents.length = 0;
    await renderViewport(root, [...replacementChunks, { id: 5, data: 'tail-live\n', replayData: 'tail-replay\n', byteLength: 10 }]);
    expect(terminalEvents).toEqual([{ type: 'write', data: 'tail-live\n' }]);
  });

  test('passes the PTY size a snapshot was drawn for so the surface replays at that size', async () => {
    const history = '[7m%[0m' + ' '.repeat(93) + '\r \r[J~ ❯ ';
    const chunks: TerminalChunk[] = [
      { id: 1, data: history, byteLength: history.length, size: { cols: 94, rows: 56 } },
      { id: 2, data: 'live\n', byteLength: 5 },
    ];

    await renderViewport(root, chunks);
    await flushSurfaceLoad();

    expect(terminalEvents.filter((event) => event.type === 'reset' || event.type === 'write')).toEqual([
      { type: 'reset', data: history, size: { cols: 94, rows: 56 } },
      { type: 'write', data: 'live\n' },
    ]);

    terminalEvents.length = 0;
    await renderViewport(root, [...chunks, { id: 3, data: 'more\n', byteLength: 5 }]);
    expect(terminalEvents).toEqual([{ type: 'write', data: 'more\n' }]);
  });

  test('toggles surface visibility with the prop and disposes on unmount', async () => {
    await renderViewport(root, [], false);
    await flushSurfaceLoad();
    const hiddenEvents = terminalEvents.filter((event) => event.type === 'visible');
    expect(hiddenEvents.length).toBeGreaterThan(0);
    expect(hiddenEvents.every((event) => event.type === 'visible' && !event.visible)).toBe(true);

    await renderViewport(root, [], true);
    expect(terminalEvents.at(-1)).toEqual({ type: 'visible', visible: true });

    await act(async () => root.unmount());
    expect(terminalEvents.at(-1)).toEqual({ type: 'dispose' });
    root = createRoot(host);
  });
});
