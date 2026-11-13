import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type Event = { type: 'connect' | 'data' | 'close'; id: string; connectionId: string; data?: string };
type Socket = {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
};

let nativeEvent: (event: Event) => void = () => {};
let localPort = 49301;
let failAuth = false;
let authFinished: (() => void) | null = null;
let requestedPath = '';
const sockets: Socket[] = [];
const sentBuffers: ArrayBuffer[] = [];
const started: string[] = [];
const stopped: string[] = [];
const readStarts: string[] = [];
const reads: string[] = [];
const writes: Array<{ id: string; connectionId: string; data: string }> = [];
const closed: string[] = [];
const native = {
  addListener: mock(async (_event: string, handler: typeof nativeEvent) => {
    nativeEvent = handler;
    return { remove: async () => {} };
  }),
  start: mock(async ({ id }: { id: string }) => {
    started.push(id);
    return { localPort };
  }),
  stop: mock(async ({ id }: { id: string }) => { stopped.push(id); }),
  ready: mock(async ({ connectionId }: { connectionId: string }) => { readStarts.push(connectionId); }),
  ack: mock(async ({ connectionId }: { connectionId: string }) => { reads.push(connectionId); }),
  send: mock(async (data: { id: string; connectionId: string; data: string }) => { writes.push(data); }),
  close: mock(async ({ connectionId }: { connectionId: string }) => { closed.push(connectionId); }),
};

mock.module('@capacitor/core', () => ({ registerPlugin: () => native }));
mock.module('@/lib/runtime-auth', () => ({
  refreshRuntimeUrlAuthToken: async () => {
    if (authFinished) await new Promise<void>((resolve) => { authFinished = resolve; });
    if (failAuth) throw new Error('authentication failed');
    return 'short-lived-token';
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeApiBaseUrl: () => 'relay://host' }));
mock.module('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({
  websocket: (path: string) => { requestedPath = path; return 'wss://test' + path; },
}) }));
mock.module('@/lib/relay/runtime-socket', () => ({
  openRuntimeWebSocket: () => {
    const socket: Socket = {
      readyState: 0,
      binaryType: 'blob',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: mock((data: ArrayBuffer) => { sentBuffers.push(data); }),
      close: mock(() => {}),
    };
    sockets.push(socket);
    return socket;
  },
}));

const { openMobileDevTunnel, closeMobileDevTunnels } = await import('./mobileDevTunnel');
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('mobile dev-server tunnel bridge', () => {
  beforeEach(() => {
    localPort = 49301;
    failAuth = false;
    authFinished = null;
    requestedPath = '';
    sockets.length = 0;
    sentBuffers.length = 0;
    started.length = 0;
    stopped.length = 0;
    readStarts.length = 0;
    reads.length = 0;
    writes.length = 0;
    closed.length = 0;
  });

  afterEach(() => {
    closeMobileDevTunnels();
  });

  test('routes raw HTTP bytes and HMR upgrades over the same authenticated connection', async () => {
    expect(await openMobileDevTunnel('/api/dev-tunnel?port=5173')).toBe(49301);
    const id = started[0];
    nativeEvent({ id, connectionId: 'http-1', type: 'connect' });
    await tick();
    expect(requestedPath).toBe('/api/dev-tunnel?port=5173');
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen?.();
    await tick();
    expect(readStarts).toEqual(['http-1']);

    const incoming = new TextEncoder().encode('GET /app.js HTTP/1.1\r\nHost: localhost\r\n\r\n');
    nativeEvent({ id, connectionId: 'http-1', type: 'data', data: btoa(String.fromCharCode(...incoming)) });
    await tick();
    expect(new TextDecoder().decode(sentBuffers[0])).toEqual(
      'GET /app.js HTTP/1.1\r\nHost: localhost\r\n\r\n',
    );
    expect(reads).toEqual(['http-1']);

    const response = new TextEncoder().encode('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
    socket.onmessage?.({ data: response.buffer });
    await tick();
    expect(atob(writes[0].data)).toBe(String.fromCharCode(...response));
    expect(writes[0].connectionId).toBe('http-1');
    // Byte framing is opaque; upgrade traffic is sent on the same socket.
    socket.onmessage?.({ data: new Uint8Array([0x81, 0x02, 0x48, 0x49]).buffer });
    await tick();
    expect(atob(writes[1].data)).toBe('\x81\x02HI');
  });

  test('stops the local listener and all live sockets on a runtime switch', async () => {
    await openMobileDevTunnel('/api/dev-tunnel?port=3000');
    const id = started[0];
    nativeEvent({ id, connectionId: 'one', type: 'connect' });
    await tick();
    closeMobileDevTunnels();
    await tick();
    expect(stopped).toContain(id);
    expect(closed).toContain('one');
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    nativeEvent({ id, connectionId: 'late', type: 'connect' });
    await tick();
    expect(sockets).toHaveLength(1);
  });

  test('refuses a bad listener and does not keep a port or orphan socket', async () => {
    localPort = 0;
    expect(openMobileDevTunnel('/api/dev-tunnel?port=3000')).rejects.toThrow('Invalid native dev tunnel listener');
    await tick();
    expect(stopped).toEqual(started);
    expect(sockets).toHaveLength(0);
  });

  test('refuses a WebSocket when authentication fails', async () => {
    await openMobileDevTunnel('/api/dev-tunnel?port=3000');
    failAuth = true;
    nativeEvent({ id: started[0], connectionId: 'unauthorized', type: 'connect' });
    await tick();
    expect(closed).toContain('unauthorized');
    expect(sockets).toHaveLength(0);
    expect(readStarts).toHaveLength(0);
  });

  test('ignores a connect that finishes authenticating after the listener closed', async () => {
    await openMobileDevTunnel('/api/dev-tunnel?port=3000');
    authFinished = () => {};
    nativeEvent({ id: started[0], connectionId: 'cancelled', type: 'connect' });
    await tick();
    const finish = authFinished;
    closeMobileDevTunnels();
    finish?.();
    await tick();
    expect(sockets).toHaveLength(0);
  });
});
