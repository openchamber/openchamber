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
