import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let apiBaseUrl = 'https://remote.example.test';

let tunnelResult: unknown = { localPort: 52418, reused: false };
mock.module('@/lib/desktopNative', () => ({
  invokeDesktopCommand: mock(async () => {
    if (tunnelResult instanceof Error) throw tunnelResult;
    return tunnelResult;
  }),
}));
mock.module('@/lib/runtime-auth', () => ({
  getRuntimeBearerTokenSync: () => 'token',
  getRuntimeExtraHeadersSync: () => ({}),
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => apiBaseUrl,
  subscribeRuntimeEndpointChanged: () => () => {},
}));

const {
  DevTunnelUnavailableError,
  resolveBrowsableUrl,
  shouldTunnelLoopbackUrl,
  toDisplayUrl,
} = await import('./devTunnel');

const globalScope = globalThis as unknown as { window?: unknown };

const asDesktop = (value: boolean) => {
  globalScope.window = value
    ? { __OPENCHAMBER_ELECTRON__: true, location: { href: 'http://127.0.0.1:3901/' } }
    : { location: { href: 'http://127.0.0.1:3901/' } };
};

describe('loopback navigations against a remote instance', () => {
  beforeEach(() => {
    apiBaseUrl = 'https://remote.example.test';
    tunnelResult = { localPort: 52418, reused: false };
    asDesktop(true);
  });

  afterEach(() => {
    delete globalScope.window;
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

  test('a local instance resolves its own loopback correctly', () => {
    apiBaseUrl = 'http://127.0.0.1:3901';
    expect(shouldTunnelLoopbackUrl('http://localhost:4322/docs/')).toBe(false);
  });

  test('nothing is tunneled outside the desktop shell', () => {
    asDesktop(false);
    expect(shouldTunnelLoopbackUrl('http://localhost:4322/docs/')).toBe(false);
  });
});
