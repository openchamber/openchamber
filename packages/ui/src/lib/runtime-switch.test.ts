import { describe, expect, test } from 'bun:test';
import { getActiveRelayTunnel, getRuntimeApiBaseUrl, switchRuntimeEndpoint } from './runtime-switch';
import { clearRuntimeUrlAuthToken, setRuntimeExtraHeaders } from './runtime-auth';
import { setRuntimeTunnelClientFactoriesForTests } from './relay/runtime-tunnel';
import type { RelayTunnelClient } from './relay/tunnel-client';

describe('runtime endpoint switching', () => {
  test('does not throw when Electron preload globals are read-only', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const runtimeWindow = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };

    try {
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      globalThis.fetch = (async () => new Response(JSON.stringify({ token: 'url-token', expiresAt: Date.now() + 60_000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_API_BASE_URL__', {
        configurable: true,
        value: 'http://127.0.0.1:3000',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_CLIENT_TOKEN__', {
        configurable: true,
        value: '',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_RUNTIME_HEADERS__', {
        configurable: true,
        value: {},
        writable: false,
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });

      let thrown: unknown = null;
      try {
        switchRuntimeEndpoint({
          apiBaseUrl: 'https://remote.example',
          clientToken: 'client-token',
          requestHeaders: null,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
      expect(getRuntimeApiBaseUrl()).toBe('https://remote.example');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

test('passes direct token separately and URL-token refresh waits behind tunnel readiness', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let receivedToken: string | null | undefined;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let completedFetches = 0;
    const client: RelayTunnelClient = {
      fetch: async () => { await ready; completedFetches += 1; return new Response(JSON.stringify({ token: 'url', expiresAt: Date.now() + 60_000 }), { status: 200 }); },
      openWebSocket: () => { throw new Error('unused'); },
      getStatus: () => ({ state: completedFetches ? 'connected' : 'connecting' }),
      subscribeStatus: () => () => {},
      close: () => {},
    };
    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: () => true } });
      setRuntimeTunnelClientFactoriesForTests({ createDirect: (_descriptor, token) => { receivedToken = token; return client; } });
      switchRuntimeEndpoint({
        apiBaseUrl: 'https://virtual.example', clientToken: 'direct-secret',
        tunnel: { type: 'direct-e2ee', wssUrl: 'wss://direct.example.test/api/openchamber/direct-e2ee/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } },
      });
      await Promise.resolve();
      expect(receivedToken).toBe('direct-secret');
      expect(completedFetches).toBe(0);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(completedFetches).toBe(1);
    } finally {
      setRuntimeTunnelClientFactoriesForTests(null);
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});

test('does not publish or construct a tokenless direct-E2EE tunnel', () => {
  let factoryCalls = 0;
  const client: RelayTunnelClient = {
    fetch: async () => new Response(null, { status: 200 }),
    openWebSocket: () => { throw new Error('unused'); },
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: () => () => {},
    close: () => {},
  };
  setRuntimeTunnelClientFactoriesForTests({
    createDirect: () => { factoryCalls += 1; return client; },
  });
  switchRuntimeEndpoint({
    apiBaseUrl: 'https://virtual.example',
    clientToken: null,
    tunnel: { type: 'direct-e2ee', wssUrl: 'wss://direct.example.test/api/openchamber/direct-e2ee/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } },
  });
  expect(factoryCalls).toBe(0);
  expect(getActiveRelayTunnel()).toBeNull();
  setRuntimeTunnelClientFactoriesForTests(null);
});
