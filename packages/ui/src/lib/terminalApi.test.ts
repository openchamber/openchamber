import { describe, expect, test } from 'bun:test';
import type { RelayTunnelWebSocket } from './relay/tunnel-client';
import { TerminalTransport } from './terminalApi';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const frame = (message: Record<string, unknown>): Uint8Array => {
  const body = encoder.encode(JSON.stringify(message));
  const result = new Uint8Array(body.length + 1);
  result[0] = 1;
  result.set(body, 1);
  return result;
};
const parseFrame = (value: string | ArrayBuffer | ArrayBufferView): Record<string, unknown> => {
  const bytes = typeof value === 'string'
    ? encoder.encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return JSON.parse(decoder.decode(bytes.subarray(1))) as Record<string, unknown>;
};

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: RelayTunnelWebSocket['onmessage'] = null;
  onerror: (() => void) | null = null;
  onclose: RelayTunnelWebSocket['onclose'] = null;
  sent: Record<string, unknown>[] = [];

  open(): void { this.readyState = 1; this.onopen?.(); }
  emit(message: Record<string, unknown>): void {
    const bytes = frame(message);
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
  }
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(parseFrame(data)); }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('terminal transport', () => {
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

    socket.emit({ t: 'snapshot', v: 3, s: 'term-1', q: 1, history: 'prompt', status: 'running' });
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
    if (typeof document !== 'undefined') Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    if (typeof navigator !== 'undefined') Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
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
        if (event.type === 'reconnecting' && typeof event.attempt === 'number') firstEvents.push(event.attempt);
      },
    });
    await tick();
    await tick();
    expect(firstEvents).toEqual([1]);

    unsubscribeFirst();
    const unsubscribeReplacement = transport.subscribe('term-2', {
      onEvent: (event) => {
        if (event.type === 'reconnecting' && typeof event.attempt === 'number') replacementEvents.push(event.attempt);
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
    let transport: TerminalTransport | null = null;

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        visibilityState: 'hidden',
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      delays.push(Number(timeout ?? 0));
      if (timeout === 0) return originalSetTimeout(handler, 0, ...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

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
      globalThis.setTimeout = originalSetTimeout;
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete (globalThis as { document?: unknown }).document;
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
