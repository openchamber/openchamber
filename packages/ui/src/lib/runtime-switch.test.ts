import { describe, expect, test } from 'bun:test';
import { getRuntimeApiBaseUrl, isRuntimeEndpointIdentityChange, switchRuntimeEndpoint } from './runtime-switch';
import { clearRuntimeUrlAuthToken, setRuntimeExtraHeaders } from './runtime-auth';

describe('runtime endpoint switching', () => {
  test('does not classify credential refreshes on the same runtime as an identity change', () => {
    expect(isRuntimeEndpointIdentityChange({
      apiBaseUrl: 'http://127.0.0.1:57123/',
      previousApiBaseUrl: 'http://127.0.0.1:57123',
      runtimeKey: 'local',
      previousRuntimeKey: 'local',
    })).toBe(false);
    expect(isRuntimeEndpointIdentityChange({
      apiBaseUrl: 'https://remote.example',
      previousApiBaseUrl: 'http://127.0.0.1:57123',
      runtimeKey: 'remote',
      previousRuntimeKey: 'local',
    })).toBe(true);
  });

  test('does not classify direct-runtime key aliases on the same endpoint as a transport change', () => {
    expect(isRuntimeEndpointIdentityChange({
      apiBaseUrl: 'http://127.0.0.1:57123',
      previousApiBaseUrl: 'http://127.0.0.1:57123',
      runtimeKey: 'local',
      previousRuntimeKey: 'url:http://127.0.0.1:57123',
    })).toBe(false);
  });

  test('still classifies relay transport changes that reuse the UI endpoint', () => {
    expect(isRuntimeEndpointIdentityChange({
      apiBaseUrl: 'openchamber-ui://app',
      previousApiBaseUrl: 'openchamber-ui://app',
      runtimeKey: 'relay-b',
      previousRuntimeKey: 'relay-a',
      transportIdentityChanged: true,
    })).toBe(true);
  });

  test('does not broadcast or remint auth for an equivalent endpoint switch', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const dispatched: Event[] = [];
    const runtimeWindow = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    };
    let fetchCalls = 0;

    try {
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return Response.json({ token: 'url-token', expiresAt: Date.now() + 60_000 });
      }) as typeof fetch;
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });

      const endpoint = {
        apiBaseUrl: 'https://same.example/api',
        clientToken: 'client-token',
        runtimeKey: 'same-runtime',
        requestHeaders: { 'X-Workspace': 'one', Authorization: 'custom' },
        relay: null,
      };
      switchRuntimeEndpoint(endpoint);
      await Promise.resolve();
      switchRuntimeEndpoint({
        ...endpoint,
        requestHeaders: { Authorization: 'custom', 'x-workspace': 'one' },
      });
      await Promise.resolve();

      expect(dispatched).toHaveLength(1);
      expect(fetchCalls).toBe(1);
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
});
