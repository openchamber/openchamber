import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { RemoteSurfaceClipboardError } from './remoteSurfaceClipboard';
import {
  RemoteSurfaceClient,
  fitFrameToStage,
  frameCanvasBackingSize,
  parseSurfaceFrameHeader,
  renderSurfaceFrame,
  viewerPointToFrameCss,
  type SurfaceFrameHeader,
} from './remoteSurface';

const attachmentIdSchema = z.string().min(1).max(128);

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.serverClose(code, reason);
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverJson(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  serverBinary(payload: Uint8Array): void {
    const copy = Uint8Array.from(payload);
    this.onmessage?.({ data: copy.buffer });
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
  }
}

type Harness = {
  readonly client: RemoteSurfaceClient;
  readonly sockets: FakeSocket[];
  readonly scheduled: Array<{ readonly callback: () => void; readonly delayMs: number }>;
  readonly warnings: string[];
  readonly refreshCount: () => number;
  readonly order: string[];
};

const createHarness = (input: {
  readonly sessionId?: string;
  readonly preferredTabId?: string;
  readonly refreshAuthToken?: () => Promise<unknown>;
} = {}): Harness => {
  const sockets: FakeSocket[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const warnings: string[] = [];
  const order: string[] = [];
  let refreshCount = 0;
  const client = new RemoteSurfaceClient({
    directory: '/project',
    sessionId: input.sessionId,
    preferredTabId: input.preferredTabId,
    refreshAuthToken: input.refreshAuthToken ?? (async () => {
      refreshCount += 1;
      order.push('refresh');
      return `token-${refreshCount}`;
    }),
    resolveSocketUrl: (directory) => {
      order.push('resolve');
      return `ws://runtime/api/browser-surface?directory=${encodeURIComponent(directory)}`;
    },
    openSocket: () => {
      order.push('open');
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectBaseDelayMs: 25,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    logger: { warn: (message) => warnings.push(String(message)) },
  });
  return { client, sockets, scheduled, warnings, refreshCount: () => refreshCount, order };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const joinProjectSession = async (harness: Harness): Promise<FakeSocket> => {
  await harness.client.start();
  const socket = harness.sockets[0];
  if (!socket) throw new Error('Expected first fake socket');
  socket.serverOpen();
  socket.serverJson({ type: 'hello' });
  if (!harness.client.getState().session) {
    socket.serverJson({ type: 'list', sessions: [] });
    harness.client.createSession();
  }
  socket.serverJson({
    type: harness.client.getState().session ? 'attached' : 'created',
    session: { id: 'session-1', directory: '/project', persistence: 'project' },
    tabs: [{ id: 'sc:target-1', targetId: 'target-1', title: 'Page', url: 'https://example.com' }],
  });
  socket.serverJson({ type: 'state', tabId: 'sc:target-1',
    attachmentRequestId: socket.messages().at(-1)?.requestId,
    lease: { actor: 'agent', generation: 1 }, controlling: false });
  await flush();
  return socket;
};

describe('remote clipboard', () => {
  test('copies only the requested tab selection and preserves its whitespace', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    const selection = harness.client.copySelection();
    const request = socket.messages().at(-1);
    expect({ type: request?.type, tabId: request?.tabId }).toEqual({ type: 'copy', tabId: 'sc:target-1' });
    socket.serverJson({ type: 'copyResult', requestId: request?.requestId, tabId: 'sc:other', ok: true, text: 'foreign' });
    socket.serverJson({ type: 'copyResult', requestId: request?.requestId, tabId: 'sc:target-1', ok: true, text: '  selected\ntext  ' });
    expect(await selection).toBe('  selected\ntext  ');
    harness.client.stop();
  });

  test('rejects empty selection and explicit copy failure without returning clipboard text', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    for (const code of ['NO_SELECTION', 'COPY_TOO_LARGE', 'COPY_FAILED'] as const) {
      const result = harness.client.copySelection();
      const rejected = Promise.allSettled([result]);
      socket.serverJson({ type: 'copyResult', requestId: socket.messages().at(-1)?.requestId,
        tabId: 'sc:target-1', ok: false, code, message: 'Cannot copy selection' });
      expect(await rejected).toEqual([{ status: 'rejected', reason: new RemoteSurfaceClipboardError(code) }]);
    }
    const result = harness.client.copySelection();
    const rejected = Promise.allSettled([result]);
    socket.serverJson({ type: 'copyResult', requestId: socket.messages().at(-1)?.requestId,
      tabId: 'sc:target-1', ok: true, text: '' });
    expect(await rejected).toEqual([{ status: 'rejected', reason: new RemoteSurfaceClipboardError('NO_SELECTION') }]);
    harness.client.stop();
  });

  test('cancels a pending copy when the selected tab changes', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    const selection = harness.client.copySelection();
    const rejected = Promise.allSettled([selection]);
    const request = socket.messages().at(-1);
    harness.client.attachTab('sc:target-2');
    socket.serverJson({ type: 'copyResult', requestId: request?.requestId, tabId: 'sc:target-1', ok: true, text: 'old tab' });
    expect(await rejected).toEqual([{ status: 'rejected', reason: new RemoteSurfaceClipboardError('COPY_CANCELLED') }]);
    harness.client.stop();
  });

  test('discards a superseded copy response while the newest request completes', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    const first = harness.client.copySelection();
    const rejected = Promise.allSettled([first]);
    const firstRequest = socket.messages().at(-1);
    const second = harness.client.copySelection();
    const secondRequest = socket.messages().at(-1);
    socket.serverJson({ type: 'copyResult', requestId: firstRequest?.requestId, tabId: 'sc:target-1', ok: true, text: 'old selection' });
    socket.serverJson({ type: 'copyResult', requestId: secondRequest?.requestId, tabId: 'sc:target-1', ok: true, text: 'current selection' });
    expect(await rejected).toEqual([{ status: 'rejected', reason: new RemoteSurfaceClipboardError('COPY_CANCELLED') }]);
    expect(await second).toBe('current selection');
    harness.client.stop();
  });

  test('cancels copy and invalidates delayed paste after stop and same-tab restart', async () => {
    const harness = createHarness();
    await joinProjectSession(harness);
    const scope = harness.client.captureInputScope();
    const selection = harness.client.copySelection();
    const rejected = Promise.allSettled([selection]);
    harness.client.stop();
    expect(await rejected).toEqual([{ status: 'rejected', reason: new RemoteSurfaceClipboardError('COPY_CANCELLED') }]);
    expect(scope()).toBe(false);
    await harness.client.start();
    expect(scope()).toBe(false);
    expect(await Promise.allSettled([harness.client.copySelection()])).toEqual([
      { status: 'rejected', reason: new RemoteSurfaceClipboardError('COPY_UNAVAILABLE') },
    ]);
    harness.client.stop();
  });

  test('cancels copy on disconnect and never replays it on reconnect', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    const selection = harness.client.copySelection();
    const rejected = Promise.allSettled([selection]);
    socket.serverClose(1006, 'connection lost');
    expect(await rejected).toEqual([{ status: 'rejected', reason: new RemoteSurfaceClipboardError('COPY_CANCELLED') }]);
    expect(harness.client.getState().phase).toBe('reconnecting');
    harness.client.stop();
  });

  test('invalidates the input scope before navigation', async () => {
    const harness = createHarness();
    await joinProjectSession(harness);
    const scope = harness.client.captureInputScope();
    expect(scope()).toBe(true);
    harness.client.navigate('https://example.com/next');
    expect(scope()).toBe(false);
    harness.client.stop();
  });

  test('rejects oversized clipboard paste without closing the connection', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    const before = socket.sent.length;
    expect(harness.client.sendText('\u0000'.repeat(12_000))).toBe(false);
    expect(socket.sent.length).toBe(before);
    expect(socket.readyState).toBe(1);
    expect(harness.client.sendText('replacement\ntext')).toBe(true);
    expect(socket.messages().at(-1)).toEqual({ type: 'text', text: 'replacement\ntext', tabId: 'sc:target-1' });
    harness.client.stop();
  });
});

describe('surface frame protocol', () => {
  test('parses a valid frame header', () => {
    const header = parseSurfaceFrameHeader({
      type: 'frame', frameSeq: 7, streamGen: 2, tabId: 'sc:target', width: 1000, height: 500, scale: 2,
    });
    expect(header).toEqual({ frameSeq: 7, streamGen: 2, tabId: 'sc:target', width: 1000, height: 500, scale: 2 });
  });

  test('drops malformed frame headers', () => {
    expect(parseSurfaceFrameHeader({ type: 'frame', frameSeq: '7', streamGen: 2, tabId: 'sc:t', width: 1, height: 1, scale: 1 })).toBeNull();
    expect(parseSurfaceFrameHeader({ type: 'frame', frameSeq: 7, streamGen: 2, tabId: '', width: 1, height: 1, scale: 1 })).toBeNull();
    expect(parseSurfaceFrameHeader({ type: 'frame', frameSeq: 7, streamGen: 2, tabId: 'sc:t', width: 0, height: 1, scale: 1 })).toBeNull();
    expect(parseSurfaceFrameHeader({ type: 'frame', frameSeq: 7, streamGen: 2, tabId: 'sc:t', width: 1, height: 1, scale: 0 })).toBeNull();
  });

  test('maps viewer coordinates to CSS pixels without double-applying frame scale', () => {
    const frame = { width: 1000, height: 500, scale: 2 };
    expect(frameCanvasBackingSize(frame)).toEqual({ width: 2000, height: 1000 });
    expect(viewerPointToFrameCss({ x: 250, y: 125 }, { width: 500, height: 250 }, frame)).toEqual({ x: 500, y: 250 });
    expect(viewerPointToFrameCss({ x: 600, y: 300 }, { width: 500, height: 250 }, frame)).toEqual({ x: 1000, y: 500 });
    expect(viewerPointToFrameCss({ x: 1, y: 1 }, { width: 0, height: 250 }, frame)).toBeNull();
    expect(fitFrameToStage(frame, { width: 500, height: 500 })).toEqual({ width: 500, height: 250 });
  });

  test('feeds a recorded JPEG through the pane renderer and draws the decoded frame', async () => {
    // SOI + minimal recorded payload + EOI. The browser decoder owns JPEG
    // validation; this test injects it to exercise the pane's canvas draw path.
    const recordedJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    const decoded = { kind: 'decoded-jpeg' };
    const drawCalls: unknown[][] = [];
    const drawImage = (...args: unknown[]): void => { drawCalls.push(args); };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
    };
    const header: SurfaceFrameHeader = {
      frameSeq: 1, streamGen: 1, tabId: 'sc:target', width: 320, height: 180, scale: 2,
    };

    const rendered = await renderSurfaceFrame(canvas, header, recordedJpeg.buffer, async (data) => {
      expect(new Uint8Array(data)).toEqual(recordedJpeg);
      return decoded;
    });

    expect(rendered).toBe(true);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(drawCalls).toEqual([[decoded, 0, 0]]);
  });
});

describe('RemoteSurfaceClient', () => {
  test('does not open a tokenless socket when URL authentication fails', async () => {
    const harness = createHarness({ refreshAuthToken: async () => {
      throw new Error('URL authentication unavailable');
    } });

    await harness.client.start();

    expect(harness.sockets).toHaveLength(0);
    expect(harness.client.getState()).toMatchObject({
      phase: 'error',
      errorMessage: 'URL authentication unavailable',
    });
  });

  test('refreshes the URL token before opening and requests the session list on hello', async () => {
    const harness = createHarness();
    await harness.client.start();
    const socket = harness.sockets[0];
    if (!socket) throw new Error('Expected fake socket');
    expect(harness.order).toEqual(['refresh', 'resolve', 'open']);
    expect(socket.binaryType).toBe('arraybuffer');
    socket.serverOpen();
    socket.serverJson({ type: 'hello' });
    expect(socket.messages()).toEqual([{ type: 'list' }]);
  });

  test('attaches directly when a persisted session id is supplied', async () => {
    const harness = createHarness({ sessionId: 'session-existing' });
    await harness.client.start();
    const socket = harness.sockets[0];
    if (!socket) throw new Error('Expected fake socket');
    socket.serverOpen();
    socket.serverJson({ type: 'hello' });
    expect(socket.messages()).toEqual([{ type: 'attach', sessionId: 'session-existing' }]);
  });

  test('creates a session, attaches its first tab, and reflects the agent lease', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    expect(socket.messages()).toEqual([
      { type: 'list' },
      { type: 'create' },
      { type: 'attachTab', tabId: 'sc:target-1', requestId: attachmentIdSchema.parse(socket.messages().at(-1)?.requestId) },
    ]);
    expect(harness.client.getState().phase).toBe('attached');
    expect(harness.client.getState().activeTabId).toBe('sc:target-1');
    expect(harness.client.getState().agentControlling).toBe(true);
  });

  test('forms pointer, key, and committed text input messages that trigger viewer takeover', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    socket.sent.length = 0;

    expect(harness.client.sendPointer({ eventType: 'down', x: 10, y: 20, button: 0 })).toBe(true);
    expect(harness.client.sendPointer({ eventType: 'move', x: 11.5, y: 21.5 })).toBe(true);
    expect(harness.client.sendKey({ eventType: 'keydown', key: 'Enter', modifiers: ['Control', 'Shift'] })).toBe(true);
    expect(harness.client.sendText('å')).toBe(true);

    expect(socket.messages()).toEqual([
      { type: 'pointer', eventType: 'down', x: 10, y: 20, button: 0, tabId: 'sc:target-1' },
      { type: 'pointer', eventType: 'move', x: 11.5, y: 21.5, tabId: 'sc:target-1' },
      { type: 'key', eventType: 'keydown', key: 'Enter', modifiers: ['Control', 'Shift'], tabId: 'sc:target-1' },
      { type: 'text', text: 'å', tabId: 'sc:target-1' },
    ]);
  });

  test('renders a valid binary frame and acks it', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    const seen: Array<{ header: SurfaceFrameHeader; bytes: number[] }> = [];
    harness.client.setFrameHandler((header, data) => {
      seen.push({ header, bytes: Array.from(new Uint8Array(data)) });
    });
    socket.sent.length = 0;

    socket.serverJson({ type: 'frame', frameSeq: 9, streamGen: 2, tabId: 'sc:target-1', width: 800, height: 600, scale: 2 });
    socket.serverBinary(Uint8Array.from([1, 2, 3]));
    await flush();

    expect(seen).toEqual([{
      header: { frameSeq: 9, streamGen: 2, tabId: 'sc:target-1', width: 800, height: 600, scale: 2 },
      bytes: [1, 2, 3],
    }]);
    expect(socket.messages()).toEqual([{ type: 'frameAck', frameSeq: 9 }]);
  });

  test('drops a malformed frame header and its binary payload without breaking later frames', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    const seen: number[] = [];
    harness.client.setFrameHandler((header) => { seen.push(header.frameSeq); });
    socket.sent.length = 0;

    socket.serverJson({ type: 'frame', frameSeq: 1, streamGen: 1, tabId: 'sc:t', width: -1, height: 10, scale: 1 });
    socket.serverBinary(Uint8Array.from([0]));
    socket.serverJson({ type: 'frame', frameSeq: 2, streamGen: 1, tabId: 'sc:t', width: 10, height: 10, scale: 1 });
    socket.serverBinary(Uint8Array.from([1]));
    await flush();

    expect(seen).toEqual([2]);
    expect(socket.messages()).toEqual([{ type: 'frameAck', frameSeq: 2 }]);
    expect(harness.warnings.some((message) => message.includes('malformed frame header'))).toBe(true);
    expect(harness.warnings.some((message) => message.includes('payload without a header'))).toBe(true);
  });

  test('drops disconnected input with a warning and never dispatches it after connect', async () => {
    const harness = createHarness();
    expect(harness.client.sendPointer({ eventType: 'down', x: 1, y: 2, button: 0 })).toBe(false);
    expect(harness.warnings).toEqual(['[remote-surface] dropped input while not attached']);

    const socket = await joinProjectSession(harness);
    expect(socket.messages().filter((message) => message.type === 'pointer')).toEqual([]);
  });

  test('refreshes auth, reattaches the session and tab, and requests the cached frame after reconnect', async () => {
    const harness = createHarness();
    const firstSocket = await joinProjectSession(harness);
    const initialRequestId = firstSocket.messages().at(-1)?.requestId;
    firstSocket.serverClose(1006, 'network lost');
    expect(harness.client.getState().phase).toBe('reconnecting');
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]?.delayMs).toBe(25);

    harness.scheduled[0]?.callback();
    await flush();
    expect(harness.refreshCount()).toBe(2);
    const secondSocket = harness.sockets[1];
    if (!secondSocket) throw new Error('Expected reconnect socket');
    expect(secondSocket.binaryType).toBe('arraybuffer');
    secondSocket.serverOpen();
    secondSocket.serverJson({ type: 'hello' });
    expect(secondSocket.messages()).toEqual([{ type: 'attach', sessionId: 'session-1' }]);

    secondSocket.serverJson({
      type: 'attached',
      session: { id: 'session-1', directory: '/project', persistence: 'project' },
      tabs: [{ id: 'sc:target-1', targetId: 'target-1', url: 'https://example.com' }],
    });
    // attachTab is both the stream re-subscription and the cached latest-frame request.
    expect(secondSocket.messages()).toEqual([
      { type: 'attach', sessionId: 'session-1' },
      { type: 'attachTab', tabId: 'sc:target-1', requestId: attachmentIdSchema.parse(secondSocket.messages().at(-1)?.requestId) },
    ]);
    const reconnectRequestId = secondSocket.messages().at(-1)?.requestId;
    expect(reconnectRequestId).not.toBe(initialRequestId);
    secondSocket.serverJson({ type: 'state', tabId: 'sc:target-1', attachmentRequestId: initialRequestId, lease: null });
    expect(harness.client.getState().phase).toBe('attaching');
    secondSocket.serverJson({ type: 'state', tabId: 'sc:target-1', attachmentRequestId: reconnectRequestId, lease: null });
    expect(harness.client.getState().phase).toBe('attached');
    harness.client.stop();
  });

  test('treats the gateway session-ended close as a crash instead of reconnecting', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    socket.serverClose(1001, 'Session ended');
    expect(harness.client.getState().phase).toBe('ended');
    expect(harness.client.getState().session).toBeNull();
    expect(harness.client.getState().activeTabId).toBeNull();
    expect(harness.scheduled).toEqual([]);
  });
});

describe('remote browser navigation', () => {
  test('creates and attaches the first tab of an empty session', async () => {
    const harness = createHarness({ sessionId: 'empty-session' });
    await harness.client.start();
    const socket = harness.sockets[0];
    if (!socket) throw new Error('Expected socket');
    socket.serverOpen();
    socket.serverJson({ type: 'hello' });
    socket.serverJson({ type: 'attached', session: { id: 'empty-session', directory: '/project' }, tabs: [] });
    expect(harness.client.getState().phase).toBe('attaching');
    expect(socket.messages().at(-1)).toEqual({ type: 'createTab' });
    socket.serverJson({ type: 'tabs', tabs: [{ id: 'sc:new', url: 'about:blank' }], activeTabId: 'sc:new' });
    expect(socket.messages().at(-1)).toEqual({ type: 'attachTab', tabId: 'sc:new',
      requestId: attachmentIdSchema.parse(socket.messages().at(-1)?.requestId) });
    expect(harness.client.getState().activeTabId).toBe('sc:new');
    harness.client.stop();
  });

  test('sends wheel and navigation commands without guessing navigation state', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    socket.sent.length = 0;
    harness.client.sendWheel({ x: 20, y: 30, deltaX: 4, deltaY: 80 });
    harness.client.navigate('https://example.com/next');
    for (const action of ['back', 'forward', 'reload', 'stop'] as const) harness.client.navigateHistory(action);
    expect(socket.messages()).toEqual([
      { type: 'wheel', tabId: 'sc:target-1', x: 20, y: 30, deltaX: 4, deltaY: 80 },
      { type: 'navigate', tabId: 'sc:target-1', url: 'https://example.com/next' },
      ...['back', 'forward', 'reload', 'stop'].map((type) => ({ type, tabId: 'sc:target-1' })),
    ]);
    expect(harness.client.getState().tabs[0]?.url).toBe('https://example.com');
    socket.serverJson({ type: 'navigation', tabId: 'sc:target-1', url: 'https://example.com/redirect', title: 'Redirect', canGoBack: true, canGoForward: false, isLoading: false });
    expect(harness.client.getState().tabs[0]).toEqual({ id: 'sc:target-1', targetId: 'target-1', url: 'https://example.com/redirect', title: 'Redirect', canGoBack: true, canGoForward: false, isLoading: false });
    harness.client.stop();
  });

  test('rejects malformed navigation and tab snapshots while retaining known tabs', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    const previous = harness.client.getState().tabs;
    socket.serverJson({ type: 'navigation', tabId: 'sc:target-1', url: 'https://bad.test', canGoBack: 'yes' });
    socket.serverJson({ type: 'tabs', tabs: 'invalid' });
    socket.serverJson({ type: 'tabs', tabs: [], activeTabId: 'sc:missing' });
    expect(harness.client.getState().tabs).toBe(previous);
    harness.client.stop();
  });

  test('keeps selection and navigation through live tab updates and attaches after a tab closes', async () => {
    const harness = createHarness();
    const socket = await joinProjectSession(harness);
    socket.serverJson({ type: 'navigation', tabId: 'sc:target-1', url: 'https://example.com', title: 'Page', canGoBack: true, canGoForward: false, isLoading: false });
    socket.sent.length = 0;
    socket.serverJson({ type: 'tabs', tabs: [{ id: 'sc:target-1', title: 'Page' }, { id: 'sc:target-2', title: 'Other page' }] });
    expect(harness.client.getState().activeTabId).toBe('sc:target-1');
    expect(harness.client.getState().tabs[0]?.canGoBack).toBe(true);
    expect(socket.messages()).toEqual([]);
    socket.serverJson({ type: 'tabs', tabs: [{ id: 'sc:target-2', title: 'Other page' }] });
    expect(harness.client.getState().activeTabId).toBe('sc:target-2');
    expect(socket.messages()).toEqual([{ type: 'attachTab', tabId: 'sc:target-2',
      requestId: attachmentIdSchema.parse(socket.messages().at(-1)?.requestId) }]);
    harness.client.stop();
  });
});
