import { describe, expect, mock, test } from 'bun:test';
import type { TerminalSessionPurpose, TerminalStreamEvent } from './api/types';
import type { RelayTunnelWebSocket } from './relay/tunnel-client';

let nextFetchResponse = (): Response => new Response(null, { status: 500 });
mock.module('./runtime-fetch', () => ({ runtimeFetch: async () => nextFetchResponse() }));
mock.module('./runtime-url', () => ({ getRuntimeUrlResolver: () => ({ websocket: () => 'ws://example.test/terminal' }) }));
mock.module('./runtime-auth', () => ({
  clearRuntimeUrlAuthToken: () => undefined,
  refreshRuntimeUrlAuthToken: async () => undefined,
}));
mock.module('./relay/runtime-socket', () => ({ openRuntimeWebSocket: () => { throw new Error('not used in tests'); } }));

const { createTerminalSession, isTerminalCwdMissingError, parseTerminalSession, parseTerminalSessionPurpose, TerminalRequestError, TerminalTransport } = await import('./terminalApi');

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type WireMessage = {
  t: string;
  s?: string;
  q?: number;
  v?: number;
  d?: string;
  r?: string;
  history?: string;
  status?: TerminalStreamEvent['status'];
  exitCode?: number;
  signal?: number | null;
  code?: string;
  message?: string;
  fatal?: boolean;
  mode?: 'interactive' | 'command';
  purpose?: TerminalSessionPurpose | { type: 'project-action'; actionId: string };
};

const frame = (message: WireMessage): Uint8Array => {
  const body = encoder.encode(JSON.stringify(message));
  const result = new Uint8Array(body.length + 1);
  result[0] = 1;
  result.set(body, 1);
  return result;
};
const parseFrame = (value: string | ArrayBuffer | ArrayBufferView): WireMessage => {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : encoder.encode(value);
  const parsed = JSON.parse(decoder.decode(bytes.subarray(1)));
  // SAFETY: test frames are encoded from `WireMessage`, so decoding that same frame preserves the wire shape here.
  return parsed as WireMessage;
};

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: RelayTunnelWebSocket['onmessage'] = null;
  onerror: (() => void) | null = null;
  onclose: RelayTunnelWebSocket['onclose'] = null;
  sent: WireMessage[] = [];

  open(): void { this.readyState = 1; this.onopen?.(); }
  emit(message: WireMessage): void {
    const bytes = frame(message);
    this.onmessage?.({ data: bytes.slice().buffer });
  }
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(parseFrame(data)); }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('terminal transport', () => {
  test('parses the terminal purpose union and rejects malformed payloads', () => {
    expect(parseTerminalSessionPurpose({ type: 'terminal' })).toEqual({ type: 'terminal' });
    expect(parseTerminalSessionPurpose({ type: 'project-action', actionId: 'build', executionId: 'exec-1' })).toEqual({
      type: 'project-action',
      actionId: 'build',
      executionId: 'exec-1',
    });
    expect(parseTerminalSessionPurpose({ type: 'project-action', actionId: 'build' })).toBe(undefined);
    expect(parseTerminalSession({
      sessionId: 'term-1',
      cols: 80,
      rows: 24,
      status: 'running',
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    })).toEqual({
      sessionId: 'term-1',
      cols: 80,
      rows: 24,
      status: 'running',
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    });
    expect(parseTerminalSession({
      sessionId: 'term-1',
      cols: 80,
      rows: 24,
      status: 'running',
      purpose: { type: 'project-action', actionId: 'build' },
    })).toBeNull();
  });

  test('surfaces the server error code so a missing working directory is recoverable', async () => {
    const options = { cwd: '/repo/.worktrees/gone', cols: 80, rows: 24 };
    nextFetchResponse = () => new Response(JSON.stringify({ error: 'Invalid working directory', code: 'TERMINAL_CWD_MISSING' }), { status: 400, headers: { 'content-type': 'application/json' } });
    try {
      await expect(createTerminalSession(options)).rejects.toThrow(TerminalRequestError);
      await expect(createTerminalSession(options)).rejects.toThrow('Invalid working directory');
      expect(await createTerminalSession(options).then(() => false, isTerminalCwdMissingError)).toBe(true);

      nextFetchResponse = () => new Response(JSON.stringify({ error: 'Invalid working directory' }), { status: 400, headers: { 'content-type': 'application/json' } });
      await expect(createTerminalSession(options)).rejects.toThrow(TerminalRequestError);
      expect(await createTerminalSession(options).then(() => false, isTerminalCwdMissingError)).toBe(false);
    } finally {
      nextFetchResponse = () => new Response(null, { status: 500 });
    }
  });

  test('hydrates simultaneous subscribers and rejects duplicate sequences', async () => {
    const socket = new FakeSocket();
    const transport = new TerminalTransport({ refreshAuth: async () => '', openSocket: () => socket });
    const firstEvents: string[] = [];
    transport.subscribe('term-1', { onEvent: (event) => firstEvents.push(`${event.type}:${event.data ?? ''}`) });
    await tick();
    socket.open();
    await tick();
    expect(socket.sent.some((message) => message.t === 'attach' && message.s === 'term-1')).toBe(true);
    expect(socket.sent.filter((message) => message.t === 'attach')).toHaveLength(1);

    socket.emit({ t: 'snapshot', v: 3, s: 'term-1', q: 1, history: 'prompt', status: 'running', mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' } });
    await tick();
    const secondEvents: string[] = [];
    transport.subscribe('term-1', { onEvent: (event) => secondEvents.push(`${event.type}:${event.data ?? ''}`) });
    expect(secondEvents).toEqual(['snapshot:prompt']);

    socket.emit({ t: 'output', v: 3, s: 'term-1', q: 2, d: ' next' });
    socket.emit({ t: 'output', v: 3, s: 'term-1', q: 2, d: ' duplicate' });
    await tick();
    expect(firstEvents).toEqual(['snapshot:prompt', 'data: next']);
    expect(secondEvents).toEqual(['snapshot:prompt', 'data: next']);

    const thirdEvents: string[] = [];
    transport.subscribe('term-1', { onEvent: (event) => thirdEvents.push(`${event.type}:${event.data ?? ''}`) });
    expect(thirdEvents).toEqual(['snapshot:prompt next']);
    transport.dispose();
  });

  test('recovers when opening the first websocket fails', async () => {
    if (globalThis.document) Object.defineProperty(globalThis.document, 'visibilityState', { configurable: true, value: 'visible' });
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
    const socket = new FakeSocket();
    let attempts = 0;
    const events: string[] = [];
    const transport = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    transport.subscribe('term-1', { onEvent: (event) => events.push(event.type) });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(attempts).toBe(2);
    expect(events).toContain('reconnecting');
    expect(socket.sent.some((message) => message.t === 'attach')).toBe(true);
    transport.dispose();
  });

  test('invalidates URL auth when the current socket closes before opening', async () => {
    const socket = new FakeSocket();
    let cleared = 0;
    const transport = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => socket,
      clearUrlAuthToken: () => { cleared += 1; },
    });

    const unsubscribe = transport.subscribe('term-1', { onEvent: () => {} });
    await tick();
    socket.close();
    await tick();

    expect(cleared).toBe(1);
    unsubscribe();
    transport.dispose();
  });

  test('invalidates URL auth before retrying a pre-open socket error', async () => {
    const socket = new FakeSocket();
    let cleared = 0;
    const transport = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => socket,
      clearUrlAuthToken: () => { cleared += 1; },
    });

    const unsubscribe = transport.subscribe('term-1', { onEvent: () => {} });
    await tick();
    socket.onerror?.();

    expect(cleared).toBe(1);
    unsubscribe();
    transport.dispose();
  });

  test('does not let a cancelled opening reconnect a replacement subscription', async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let socketIndex = 0;
    const replacementEvents: string[] = [];
    const transport = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => sockets[socketIndex++]!,
    });

    const unsubscribeFirst = transport.subscribe('term-1', { onEvent: () => {} });
    await tick();
    unsubscribeFirst();

    const unsubscribeReplacement = transport.subscribe('term-1', {
      onEvent: (event) => replacementEvents.push(event.type),
    });
    await tick();
    sockets[1]?.open();
    await tick();

    expect(replacementEvents).not.toContain('reconnecting');
    unsubscribeReplacement();
    transport.dispose();
  });

  test('starts a fresh reconnect sequence after every terminal has detached', async () => {
    const firstEvents: number[] = [];
    const replacementEvents: number[] = [];
    const transport = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => { throw new Error('offline'); },
    });

    const unsubscribeFirst = transport.subscribe('term-1', {
      onEvent: (event) => {
        if (event.type !== 'reconnecting' || event.attempt == null) return;
        firstEvents.push(event.attempt);
      },
    });
    await tick();
    await tick();
    expect(firstEvents).toEqual([1]);

    unsubscribeFirst();
    const unsubscribeReplacement = transport.subscribe('term-2', {
      onEvent: (event) => {
        if (event.type !== 'reconnecting' || event.attempt == null) return;
        replacementEvents.push(event.attempt);
      },
    });
    await tick();
    await tick();

    expect(replacementEvents).toEqual([1]);
    unsubscribeReplacement();
    transport.dispose();
  });

  test('waits a minute before reconnecting while hidden', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const delays: number[] = [];
    let transport: InstanceType<typeof TerminalTransport> | null = null;

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        visibilityState: 'hidden',
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        delays.push(Number(timeout ?? 0));
        if (timeout === 0) return originalSetTimeout(handler, 0, ...args);
        const handle = originalSetTimeout(() => {}, 0);
        clearTimeout(handle);
        return handle;
      },
    });

    try {
      transport = new TerminalTransport({
        refreshAuth: async () => '',
        openSocket: () => { throw new Error('offline'); },
      });
      transport.subscribe('term-1', { onEvent: () => {} });
      await tick();
      await tick();

      expect(delays).toContain(60_000);
    } finally {
      transport?.dispose();
      Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: originalSetTimeout });
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  test('attaches a remaining same-terminal subscriber after the first one leaves', async () => {
    const socket = new FakeSocket();
    const transport = new TerminalTransport({ refreshAuth: async () => '', openSocket: () => socket });

    const unsubscribeOther = transport.subscribe('term-other', { onEvent: () => {} });
    await tick();
    socket.open();
    await tick();

    const unsubscribeFirst = transport.subscribe('term-1', { onEvent: () => {} });
    const unsubscribeRemaining = transport.subscribe('term-1', { onEvent: () => {} });
    unsubscribeFirst();
    await tick();

    expect(socket.sent.filter((message) => message.t === 'attach' && message.s === 'term-1')).toHaveLength(1);
    unsubscribeRemaining();
    unsubscribeOther();
    transport.dispose();
  });

  test('releases replay projections when the last subscriber detaches', async () => {
    const socket = new FakeSocket();
    const transport = new TerminalTransport({ refreshAuth: async () => '', openSocket: () => socket });
    const unsubscribe = transport.subscribe('term-1', { onEvent: () => {} });
    await tick();
    socket.open();
    await tick();
    socket.emit({ t: 'snapshot', v: 3, s: 'term-1', q: 1, history: 'large replay', status: 'running' });
    await tick();
    unsubscribe();

    const events: string[] = [];
    transport.subscribe('term-1', { onEvent: (event) => events.push(event.type) });
    expect(events).toEqual([]);
    transport.dispose();
  });

  test('uses replay-safe output for projections and preserves terminal error codes', async () => {
    const socket = new FakeSocket();
    const transport = new TerminalTransport({ refreshAuth: async () => '', openSocket: () => socket });
    let errorCode: string | undefined;
    transport.subscribe('term-1', { onEvent: () => {}, onError: (error) => { errorCode = error.code; } });
    await tick();
    socket.open();
    await tick();
    socket.emit({ t: 'snapshot', v: 3, s: 'term-1', q: 0, history: '', status: 'running' });
    socket.emit({ t: 'output', v: 3, s: 'term-1', q: 1, d: 'prompt\u001b[6n', r: 'prompt' });
    await tick();

    const replay: string[] = [];
    transport.subscribe('term-1', { onEvent: (event) => { if (event.type === 'snapshot') replay.push(event.data ?? ''); } });
    expect(replay).toEqual(['prompt']);

    socket.emit({ t: 'error', v: 3, s: 'term-1', code: 'SESSION_NOT_FOUND', message: 'missing', fatal: true });
    await tick();
    expect(errorCode).toBe('SESSION_NOT_FOUND');
    transport.dispose();
  });

  test('preserves valid snapshot purpose and rejects a malformed restarted frame', async () => {
    const socket = new FakeSocket();
    const transport = new TerminalTransport({ refreshAuth: async () => '', openSocket: () => socket });
    const purposes: Array<string | null> = [];
    transport.subscribe('term-1', {
      onEvent: (event) => {
        if (event.type !== 'snapshot') return;
        purposes.push(event.purpose?.type === 'project-action' ? event.purpose.executionId : null);
      },
    });
    await tick();
    socket.open();
    await tick();
    socket.emit({ t: 'snapshot', v: 3, s: 'term-1', q: 1, history: 'prompt', status: 'running', purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' } });
    socket.emit({ t: 'restarted', v: 3, s: 'term-1', q: 2, history: 'prompt 2', purpose: { type: 'project-action', actionId: 'build' } });
    await tick();
    expect(purposes).toEqual(['exec-1']);
    transport.dispose();
  });

  test('reuses the open socket when switching between terminals', async () => {
    const sockets: FakeSocket[] = [];
    let authCalls = 0;
    const transport = new TerminalTransport({
      refreshAuth: async () => { authCalls += 1; },
      openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });

    const unsubscribeFirst = transport.subscribe('term-1', { onEvent: () => {} });
    await tick();
    sockets[0].open();
    await tick();
    expect(authCalls).toBe(1);

    // Switching tabs detaches the old terminal before attaching the new one.
    unsubscribeFirst();
    transport.subscribe('term-2', { onEvent: () => {} });
    await tick();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].readyState).toBe(1);
    expect(authCalls).toBe(1);
    expect(sockets[0].sent.some((message) => message.t === 'detach' && message.s === 'term-1')).toBe(true);
    expect(sockets[0].sent.some((message) => message.t === 'attach' && message.s === 'term-2')).toBe(true);
    transport.dispose();
  });

  test('disposing closes a socket that was being held for reuse', async () => {
    const sockets: FakeSocket[] = [];
    const transport = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });

    const unsubscribe = transport.subscribe('term-1', { onEvent: () => {} });
    await tick();
    sockets[0].open();
    await tick();

    unsubscribe();
    expect(sockets[0].readyState).toBe(1);
    transport.dispose();
    expect(sockets[0].readyState).toBe(3);
  });

  test('does not reconnect after the last subscriber detaches', async () => {
    let attempts = 0;
    const transport = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => {
        attempts += 1;
        throw new Error('offline');
      },
    });
    const unsubscribe = transport.subscribe('term-1', { onEvent: () => {} });
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(attempts).toBe(0);
    transport.dispose();
  });

  test('single-flights auth and socket opening for an immediate first write', async () => {
    const sockets: FakeSocket[] = [];
    let authCalls = 0;
    const transport = new TerminalTransport({
      refreshAuth: async () => { authCalls += 1; await tick(); },
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    transport.subscribe('term-1', { onEvent: () => {} });
    await transport.write('term-1', 'bun run dev\r');
    expect(authCalls).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.filter((message) => message.t === 'write')).toEqual([
      { t: 'write', v: 3, s: 'term-1', d: 'bun run dev\r' },
    ]);
    transport.dispose();
  });
});
