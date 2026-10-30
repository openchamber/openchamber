import { describe, expect, test } from 'bun:test';
import { nativeWebSocketHeaders, openNativeWebSocket } from './native-websocket';

type Plugin = NonNullable<Parameters<typeof openNativeWebSocket>[3]>;
type SocketEvent = Parameters<Parameters<Plugin['addListener']>[1]>[0];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

const fixture = () => {
  let listener: (event: SocketEvent) => void = () => {};
  let id = '';
  let removals = 0;
  const sent: Parameters<Plugin['send']>[0][] = [];
  const closed: Parameters<Plugin['close']>[0][] = [];
  const opened: Parameters<Plugin['open']>[0][] = [];
  const plugin: Plugin = {
    async addListener(_name, callback) {
      listener = callback;
      return { async remove() { removals++; } };
    },
    async open(options) { id = options.id; opened.push(options); },
    async send(options) { sent.push(options); },
    async close(options) { closed.push(options); listener({ ...options, type: 'close' }); },
  };
  return { plugin, opened, sent, closed, emit: (event: Omit<Extract<SocketEvent, { type: 'open' | 'error' }>, 'id'>) => listener({ id, ...event }),
    message: (data: string, binary = false) => listener({ id, type: 'message', data, binary }),
    removals: () => removals };
};

describe('native runtime WebSocket', () => {
  test('proxy credentials only reach the active origin and base path', () => {
    const headers = { 'X-Proxy': 'secret' };
    const base = 'https://host/base/';
    expect(nativeWebSocketHeaders('wss://host/base/api/terminal', base, headers)).toEqual(headers);
    for (const url of ['wss://other/base/api/terminal', 'ws://host/base/api/terminal',
      'wss://host:444/base/api/terminal', 'wss://host/base-other/api/terminal',
      'wss://host/base/../api/terminal', 'wss://user:pass@host/base/api/terminal']) {
      expect(nativeWebSocketHeaders(url, base, headers)).toBeNull();
    }
    expect(nativeWebSocketHeaders('wss://old/base/api/terminal', 'https://new/base/', headers)).toBeNull();
  });
  test('delivers text and binary frames and preserves typed-array byte ranges', async () => {
    const f = fixture();
    const socket = openNativeWebSocket('wss://host/api/terminal', { 'X-Proxy': 'secret' }, ['terminal'], f.plugin);
    const messages: (string | ArrayBuffer)[] = [];
    socket.onmessage = (event) => messages.push(event.data);
    expect(socket.readyState).toBe(0);
    expect(() => socket.send('early')).toThrow();
    await flush();
    expect(f.opened[0]).toMatchObject({ headers: { 'X-Proxy': 'secret' }, protocols: ['terminal'] });
    f.emit({ type: 'open' });
    socket.send('first');
    socket.send(new Uint8Array([9, 0, 255, 9]).subarray(1, 3));
    f.message('hello');
    f.message('AP8=', true);
    await flush();
    expect(f.sent.map(({ data, binary }) => ({ data, binary }))).toEqual([
      { data: 'first', binary: false }, { data: 'AP8=', binary: true },
    ]);
    expect(messages).toEqual(['hello', new Uint8Array([0, 255]).buffer]);
    socket.close();
    await flush();
    expect(socket.readyState).toBe(3);
    expect(f.removals()).toBe(1);
  });

  test('close before listener registration never starts a native connection', async () => {
    const f = fixture();
    const socket = openNativeWebSocket('wss://host/ws', {}, [], f.plugin);
    socket.close();
    await flush();
    expect(f.opened).toHaveLength(0);
    expect(f.removals()).toBe(1);
  });

  test('close waits for a pending native open and suppresses late open events', async () => {
    const f = fixture();
    let release = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const open = f.plugin.open;
    f.plugin.open = async (options) => { await open(options); await pending; };
    const socket = openNativeWebSocket('wss://host/ws', {}, [], f.plugin);
    let opens = 0;
    socket.onopen = () => { opens++; };
    await flush();
    socket.close();
    f.emit({ type: 'open' });
    expect(opens).toBe(0);
    expect(f.closed).toHaveLength(0);
    release();
    await flush();
    expect(f.closed).toHaveLength(1);
    expect(socket.readyState).toBe(3);
  });

  test('serializes writes and drains them before close', async () => {
    const f = fixture();
    let release = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const send = f.plugin.send;
    f.plugin.send = async (options) => { await send(options); if (options.data === 'one') await pending; };
    const socket = openNativeWebSocket('wss://host/ws', {}, [], f.plugin);
    await flush();
    f.emit({ type: 'open' });
    socket.send('one');
    socket.send('two');
    socket.close();
    await flush();
    expect(f.sent.map((event) => event.data)).toEqual(['one']);
    expect(f.closed).toHaveLength(0);
    release();
    await flush();
    expect(f.sent.map((event) => event.data)).toEqual(['one', 'two']);
    expect(f.closed).toHaveLength(1);
  });

  test('failed handshake emits one error and one abnormal close', async () => {
    const f = fixture();
    f.plugin.open = async () => { throw new Error('Rejected'); };
    const socket = openNativeWebSocket('wss://host/ws', {}, [], f.plugin);
    let errors = 0;
    const codes: number[] = [];
    socket.onerror = () => { errors++; };
    socket.onclose = ({ code }) => codes.push(code);
    await flush();
    f.emit({ type: 'error' });
    expect(errors).toBe(1);
    expect(codes).toEqual([1006]);
    expect(f.removals()).toBe(1);
  });

  test('invalid binary frames fail closed and release the native socket', async () => {
    const f = fixture();
    const socket = openNativeWebSocket('wss://host/ws', {}, [], f.plugin);
    await flush();
    f.emit({ type: 'open' });
    f.message('!!!', true);
    await flush();
    expect(socket.readyState).toBe(3);
    expect(f.closed).toHaveLength(1);
  });

  test('queued payload overflow closes the connection without sending the oversized frame', async () => {
    const f = fixture();
    const socket = openNativeWebSocket('wss://host/ws', {}, [], f.plugin);
    await flush();
    f.emit({ type: 'open' });
    socket.send(new Uint8Array(16 * 1024 * 1024 + 1));
    await flush();
    expect(socket.readyState).toBe(3);
    expect(f.sent).toHaveLength(0);
    expect(f.closed).toHaveLength(1);
  });

  test('rejects invalid protocol and close metadata before it crosses the bridge', async () => {
    const f = fixture();
    expect(() => openNativeWebSocket('wss://host/ws', {}, ['a', 'a'], f.plugin)).toThrow();
    expect(() => openNativeWebSocket('wss://host/ws', {}, ['bad\r\nheader'], f.plugin)).toThrow();
    const socket = openNativeWebSocket('wss://host/ws', {}, [], f.plugin);
    expect(() => socket.close(1006)).toThrow();
    expect(() => socket.close(1000, 'é'.repeat(62))).toThrow();
    socket.close();
    await flush();
    expect(f.opened).toHaveLength(0);
  });
});
