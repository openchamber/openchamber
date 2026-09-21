import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let apiBaseUrl = 'https://remote.example.test';

type TunnelResult = { localPort: number; reused: boolean } | Error;
type DesktopTunnelArgs = { baseUrl?: string; port?: number; relay?: boolean; targetKey?: string };
type RelayEvent = { connectionId: string; remotePort: number; message: { type: string; data?: ArrayBuffer } };
type RelaySocketFixture = {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  readyState: number;
};

let tunnelResult: TunnelResult = { localPort: 52418, reused: false };
let desktopArgs: DesktopTunnelArgs | undefined;
let relayActive = false;
let openedRelayUrl = '';
let refreshedBaseUrl = '';
let refreshUrlAuth = async (baseUrl: string) => { refreshedBaseUrl = baseUrl; return 'url-token'; };
let relayHandler: ((event: RelayEvent) => void) | null = null;
const relayPosts: Array<{ connectionId: string; message: { type: string; data?: ArrayBuffer } }> = [];
const relaySocket: RelaySocketFixture = { binaryType: 'arraybuffer', onopen: null, onmessage: null, onerror: null, onclose: null, send: mock(() => {}), close: mock(() => {}), readyState: 0 };
mock.module('@/lib/desktopNative', () => ({
  invokeDesktopCommand: mock(async (_command: string, args?: DesktopTunnelArgs) => {
    desktopArgs = args;
    if (tunnelResult instanceof Error) throw tunnelResult;
    return tunnelResult;
  }),
  listenForDesktopRelayDevTunnels: (handler: typeof relayHandler) => { relayHandler = handler; return true; },
  postDesktopRelayDevTunnelMessage: (connectionId: string, message: { type: string; data?: ArrayBuffer }) => relayPosts.push({ connectionId, message }),
}));
mock.module('@/lib/relay/runtime-tunnel', () => ({
  isRelayModeActive: () => relayActive,
  getActiveRelayTunnel: () => relayActive ? {} : null,
}));
mock.module('@/lib/relay/runtime-socket', () => ({ openRuntimeWebSocket: (url: string) => { openedRelayUrl = url; return relaySocket; } }));
mock.module('@/lib/runtime-auth', () => ({
  getRuntimeBearerTokenSync: () => 'token',
  getRuntimeExtraHeadersSync: () => ({}),
  refreshRuntimeUrlAuthToken: (baseUrl: string) => refreshUrlAuth(baseUrl),
}));
mock.module('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ websocket: (path: string) => `openchamber-ui://app${path}&oc_url_token=test` }) }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => apiBaseUrl,
  getRuntimeKey: () => relayActive ? 'host:exe' : `url:${apiBaseUrl}`,
  subscribeRuntimeEndpointChanged: () => () => {},
}));

const {
  DevTunnelUnavailableError,
  resolveBrowsableUrl,
  shouldTunnelLoopbackUrl,
  toDisplayUrl,
} = await import('./devTunnel');

const asDesktop = (value: boolean) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: value
      ? { __OPENCHAMBER_ELECTRON__: true, location: { href: 'http://127.0.0.1:3901/' } }
      : { location: { href: 'http://127.0.0.1:3901/' } },
  });
};

describe('loopback navigations against a remote instance', () => {
  beforeEach(() => {
    apiBaseUrl = 'https://remote.example.test';
    tunnelResult = { localPort: 52418, reused: false };
    desktopArgs = undefined;
    relayActive = false;
    relayPosts.length = 0;
    openedRelayUrl = '';
    refreshedBaseUrl = '';
    refreshUrlAuth = async (baseUrl: string) => { refreshedBaseUrl = baseUrl; return 'url-token'; };
    asDesktop(true);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  test('a page reached through a tunnel keeps its other ports on the host', () => {
    expect(shouldTunnelLoopbackUrl('http://localhost:4322/docs/')).toBe(true);
  });

  test('a tunnel port is this machine on purpose and is left alone', async () => {
    const tunneled = await resolveBrowsableUrl('http://localhost:3000/');
    expect(tunneled).toBe('http://127.0.0.1:52418/');
    // Following a link inside the tunnelled page must not tunnel the tunnel.
    expect(shouldTunnelLoopbackUrl(tunneled)).toBe(false);
    // And the address bar still shows what was asked for.
    expect(toDisplayUrl(tunneled)).toBe('http://localhost:3000/');
  });

  test('a public address is not loopback at all', () => {
    expect(shouldTunnelLoopbackUrl('https://openchamber.dev/docs/')).toBe(false);
  });

  test('an implicit port is the port the scheme means, not nothing', () => {
    // http://localhost/ is port 80 on the host, and must be tunnelled like any
    // other. Reading it as 0 would send the view to this machine instead.
    expect(shouldTunnelLoopbackUrl('http://localhost/')).toBe(true);
    expect(shouldTunnelLoopbackUrl('https://localhost/')).toBe(true);
  });

  test('a failed tunnel is reported, never answered by this machine', async () => {
    tunnelResult = new Error('discovery unavailable');
    let failed = false;
    try {
      // A port no earlier test opened: a successful tunnel is cached per target.
      await resolveBrowsableUrl('http://localhost:3100/');
    } catch (error) {
      failed = error instanceof DevTunnelUnavailableError;
    }
    // Falling back to the plain loopback URL would show whatever runs on that
    // port here, under the address of a server on another machine.
    expect(failed).toBe(true);
  });

  test('a relay-only runtime asks Electron for a local relay bridge', async () => {
    relayActive = true;
    apiBaseUrl = 'openchamber-ui://app';
    const resolved = await resolveBrowsableUrl('http://localhost:4322/docs/');
    expect(resolved).toBe('http://127.0.0.1:52418/docs/');
    expect(desktopArgs?.relay).toBe(true);
    expect(desktopArgs?.targetKey).toBe('host:exe');
    expect(desktopArgs?.port).toBe(4322);

    relayHandler?.({ connectionId: 'connection-1', remotePort: 4322, message: { type: 'connect' } });
    await Promise.resolve();
    await Promise.resolve();
    relaySocket.onopen?.();
    expect(refreshedBaseUrl).toBe('openchamber-ui://app');
    expect(openedRelayUrl).toContain('/api/dev-tunnel?port=4322&oc_url_token=test');
    expect(relayPosts.some((entry) => entry.connectionId === 'connection-1' && entry.message.type === 'ready')).toBe(true);
  });

  test('a local disconnect during auth does not leave an orphan relay socket', async () => {
    relayActive = true;
    apiBaseUrl = 'openchamber-ui://app';
    let finishAuth = () => {};
    refreshUrlAuth = () => new Promise<string>((resolve) => { finishAuth = () => resolve('url-token'); });

    relayHandler?.({ connectionId: 'connection-cancelled', remotePort: 4322, message: { type: 'connect' } });
    relayHandler?.({ connectionId: 'connection-cancelled', remotePort: 4322, message: { type: 'close' } });
    finishAuth();
    await Promise.resolve();
    await Promise.resolve();

    expect(openedRelayUrl).toBe('');
  });

  test('a local instance resolves its own loopback correctly', () => {
    apiBaseUrl = 'http://127.0.0.1:3901';
    expect(shouldTunnelLoopbackUrl('http://localhost:4322/docs/')).toBe(false);
  });

  test('nothing is tunneled outside the desktop shell', () => {
    asDesktop(false);
    expect(shouldTunnelLoopbackUrl('http://localhost:4322/docs/')).toBe(false);
  });
});
