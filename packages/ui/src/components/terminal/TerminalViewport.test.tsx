import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { useTerminalStore, type TerminalChunk } from '@/stores/useTerminalStore';

import { TerminalViewport, type TerminalSurface, type TerminalSurfaceFactory } from './TerminalViewport';

type TerminalEvent =
  | { type: 'write'; data: string }
  | { type: 'reset'; data: string; size?: { cols: number; rows: number } }
  | { type: 'visible'; visible: boolean }
  | { type: 'dispose' };
const terminalEvents: TerminalEvent[] = [];

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
  focus() {}
  getSelection() {
    return '';
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

const createSurface: TerminalSurfaceFactory = () => Promise.resolve(new TerminalSurfaceDouble());

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

const renderViewport = (root: Root, chunks: TerminalChunk[], isVisible = true) => act(async () => {
  root.render(
    <I18nProvider>
      <TerminalViewport
        sessionKey="session-1"
        chunks={chunks}
        onInput={() => undefined}
        onResize={() => undefined}
        theme={theme}
        monoFont="system-mono"
        fontFamily="Menlo"
        fontSize={14}
        isVisible={isVisible}
        createSurface={createSurface}
      />
    </I18nProvider>,
  );
});

describe('TerminalViewport chunk replay integration', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    terminalEvents.length = 0;
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
