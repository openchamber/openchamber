import { describe, expect, test } from 'bun:test';
import {
  buildRuntimeAuthHeaders,
  clearRuntimeAuthCredentialProvider,
  clearRuntimeUrlAuthToken,
  getRuntimeBearerTokenSync,
  hasSameOriginTunnelSession,
  refreshRuntimeUrlAuthToken,
  refreshLocalRuntimeUrlAuthToken,
  getLocalRuntimeUrlAuthTokenSync,
  setRuntimeAuthCredentialProvider,
  setRuntimeBearerToken,
  setRuntimeExtraHeaders,
} from './runtime-auth';
import { createRuntimeUrlResolver } from './runtime-url';

describe('runtime auth headers', () => {
  test('confirms only a same-origin authenticated tunnel session without forwarding runtime headers', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    let scope = 'tunnel';
    let fetchCalls = 0;
    try {
      setRuntimeExtraHeaders(null);
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://host.example', href: 'https://host.example/' } },
      });
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({ authenticated: true, scope }), { status: 200 });
      };

      expect(await hasSameOriginTunnelSession('https://host.example/auth/session')).toBe(true);
      expect(requestUrl).toBe('https://host.example/auth/session');
      expect(requestInit?.credentials).toBe('same-origin');
      expect(requestInit?.mode).toBe('same-origin');
      expect(requestInit?.redirect).toBe('error');
      expect(requestInit?.headers).toBeUndefined();

      setRuntimeBearerToken('test-token');
      expect(await hasSameOriginTunnelSession('https://host.example/auth/session')).toBe(false);
      clearRuntimeAuthCredentialProvider();
      setRuntimeExtraHeaders({ 'x-runtime-test': 'enabled' });
      expect(await hasSameOriginTunnelSession('https://host.example/auth/session')).toBe(false);
      setRuntimeExtraHeaders(null);

      scope = 'user';
      expect(await hasSameOriginTunnelSession('https://host.example/auth/session')).toBe(false);
      expect(await hasSameOriginTunnelSession('https://other.example/auth/session')).toBe(false);
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      setRuntimeExtraHeaders(null);
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('does not add authorization by default', async () => {
    clearRuntimeAuthCredentialProvider();
    const headers = await buildRuntimeAuthHeaders({ Accept: 'application/json' });

    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.has('Authorization')).toBe(false);
  });

  test('abandons a stalled tunnel status read so normal terminal auth can continue', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: new URL('https://host.example/') } });
    let aborted = false;
    try {
      globalThis.fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason); }, { once: true });
      });
      expect(await hasSameOriginTunnelSession('/auth/session')).toBe(false);
      expect(aborted).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('adds bearer token when configured', async () => {
    try {
      setRuntimeBearerToken('token-123');
      const headers = await buildRuntimeAuthHeaders();

      expect(headers.get('Authorization')).toBe('Bearer token-123');
    } finally {
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('preserves explicit authorization header', async () => {
    try {
      setRuntimeAuthCredentialProvider(() => ({ type: 'bearer', token: 'runtime-token' }));
      const headers = await buildRuntimeAuthHeaders({ Authorization: 'Bearer explicit-token' });

      expect(headers.get('Authorization')).toBe('Bearer explicit-token');
    } finally {
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('falls back to injected desktop client token', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
      clearRuntimeAuthCredentialProvider();
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { __OPENCHAMBER_CLIENT_TOKEN__: ' injected-token ' },
      });

      expect(getRuntimeBearerTokenSync()).toBe('injected-token');

      const headers = await buildRuntimeAuthHeaders();
      expect(headers.get('Authorization')).toBe('Bearer injected-token');
    } finally {
      clearRuntimeAuthCredentialProvider();
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('adds runtime extra headers without overriding bearer authorization', async () => {
    try {
      setRuntimeBearerToken('runtime-token');
      setRuntimeExtraHeaders({
        'CF-Access-Client-Id': 'client-id',
        Authorization: 'Bearer proxy-token',
      });

      const headers = await buildRuntimeAuthHeaders();

      expect(headers.get('CF-Access-Client-Id')).toBe('client-id');
      expect(headers.get('Authorization')).toBe('Bearer runtime-token');
    } finally {
      setRuntimeExtraHeaders(null);
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('sends runtime extra headers when minting URL auth tokens', async () => {
    const previousFetch = globalThis.fetch;
    let seenUrl = '';
    let seenHeaders = new Headers();
    try {
      clearRuntimeUrlAuthToken();
      setRuntimeBearerToken('runtime-token');
      setRuntimeExtraHeaders({
        'CF-Access-Client-Id': 'client-id',
        Authorization: 'Bearer proxy-token',
      });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ token: 'url-token', expiresAt: Date.now() + 60_000 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const token = await refreshRuntimeUrlAuthToken('https://runtime.example');

      expect(token).toBe('url-token');
      expect(seenUrl).toBe('https://runtime.example/auth/url-token');
      expect(seenHeaders.get('CF-Access-Client-Id')).toBe('client-id');
      expect(seenHeaders.get('Authorization')).toBe('Bearer runtime-token');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not remint URL auth token when setting equivalent empty runtime headers', async () => {
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      clearRuntimeUrlAuthToken();
      setRuntimeBearerToken('runtime-token');
      setRuntimeExtraHeaders(null);
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ token: `url-token-${fetchCount}`, expiresAt: Date.now() + 60_000 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const firstToken = await refreshRuntimeUrlAuthToken('https://runtime.example');
      setRuntimeExtraHeaders({});
      const secondToken = await refreshRuntimeUrlAuthToken('https://runtime.example');

      expect(firstToken).toBe('url-token-1');
      expect(secondToken).toBe('url-token-1');
      expect(fetchCount).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('keeps a fresh URL token when the server clock is behind this device', async () => {
    const previousFetch = globalThis.fetch;
    try {
      clearRuntimeUrlAuthToken();
      setRuntimeBearerToken('runtime-token');
      // Server clock 90 s behind: its absolute expiry is already past here.
      const mintFromSlowServerClock: typeof fetch = async () => Response.json({
        token: 'fresh-url-token',
        expiresAt: Date.now() - 30_000,
        expiresIn: 60_000,
      });
      globalThis.fetch = mintFromSlowServerClock;

      await refreshRuntimeUrlAuthToken('https://runtime.example');
      const socketUrl = new URL(createRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' }).websocket('/api/terminal/ws'));

      expect(socketUrl.searchParams.get('oc_url_token')).toBe('fresh-url-token');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('never reuses a local URL token for another origin', async () => {
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      clearRuntimeUrlAuthToken();
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetchCount += 1;
        const origin = new URL(String(input)).origin;
        return Response.json({ token: `${origin}-token`, expiresAt: Date.now() + 60_000 });
      }) as typeof fetch;

      const a = await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3001');
      const b = await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3002');

      expect(a).toBe('http://127.0.0.1:3001-token');
      expect(b).toBe('http://127.0.0.1:3002-token');
      expect(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3001')).toBe('');
      expect(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3002')).toBe(b);
      expect(fetchCount).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
    }
  });

  test('rejects a local mint that completes after switching origins', async () => {
    const previousFetch = globalThis.fetch;
    let resolveA!: (response: Response) => void;
    try {
      clearRuntimeUrlAuthToken();
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const origin = new URL(String(input)).origin;
        if (origin.endsWith(':3001')) return new Promise<Response>((resolve) => { resolveA = resolve; });
        return Promise.resolve(Response.json({ token: 'token-b', expiresAt: Date.now() + 60_000 }));
      }) as typeof fetch;

      const requestA = refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3001');
      const tokenB = await refreshLocalRuntimeUrlAuthToken('http://127.0.0.1:3002');
      resolveA(Response.json({ token: 'token-a', expiresAt: Date.now() + 60_000 }));

      expect(tokenB).toBe('token-b');
      await expect(requestA).rejects.toThrow('stale');
      expect(getLocalRuntimeUrlAuthTokenSync('http://127.0.0.1:3002')).toBe('token-b');
    } finally {
      globalThis.fetch = previousFetch;
      clearRuntimeUrlAuthToken();
    }
  });
});
