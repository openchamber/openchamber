import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ui-auth-test-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const loadCreateUiAuth = async () => {
  const module = await import('./ui-auth.js');
  return module.createUiAuth;
};

const createResponse = () => {
  let statusCode = 200;
  let body = null;
  const headers = new Map();
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
  };
};

describe('ui auth client credential seam', () => {
  it('accepts bearer client credentials when UI password auth is enabled', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const req = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const res = createResponse();
    let called = false;

    await auth.requireAuth(req, res, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(await auth.ensureSessionToken(req, res)).toBe('client:device-1');
    expect(await auth.resolveAuthContext(req, res, { allowUrlToken: false })).toMatchObject({
      type: 'client',
      clientId: 'device-1',
      token: 'client:device-1',
    });
  });

  it('does not accept bearer client credentials for UI-session-only auth', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const clientReq = { method: 'GET', path: '/api/client-auth/clients', headers: { authorization: 'Bearer client-token' } };
    const clientRes = createResponse();
    let clientCalled = false;
    await auth.requireSessionAuth(clientReq, clientRes, () => {
      clientCalled = true;
    });
    expect(clientCalled).toBe(false);
    expect(clientRes.statusCode).toBe(401);

    const loginReq = { method: 'POST', headers: {}, body: { password: 'secret' } };
    const loginRes = createResponse();
    await auth.handleSessionCreate(loginReq, loginRes);
    const sessionCookie = String(loginRes.getHeader('set-cookie') || '').split(';', 1)[0];
    expect(sessionCookie.startsWith('oc_ui_session=')).toBe(true);

    const sessionReq = { method: 'GET', path: '/api/client-auth/clients', headers: { cookie: sessionCookie } };
    const sessionRes = createResponse();
    let sessionCalled = false;
    await auth.requireSessionAuth(sessionReq, sessionRes, () => {
      sessionCalled = true;
    });
    expect(sessionCalled).toBe(true);
  });

  it('can require bearer client credentials when UI password is disabled', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      requireClientAuth: true,
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, sessionToken: 'remote-session' } : null,
      },
    });

    const allowedReq = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const allowedRes = createResponse();
    let called = false;
    await auth.requireAuth(allowedReq, allowedRes, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(await auth.ensureSessionToken(allowedReq, allowedRes)).toBe('client:remote-session');

    const deniedReq = { method: 'GET', headers: {} };
    const deniedRes = createResponse();
    await auth.requireAuth(deniedReq, deniedRes, () => {});
    expect(deniedRes.statusCode).toBe(401);
    expect(deniedRes.body).toEqual({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
  });

  it('reports authenticated client session status with bearer credentials', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });
    const req = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const res = createResponse();

    await auth.handleSessionStatus(req, res);

    expect(res.body).toEqual({ authenticated: true, scope: 'client' });
  });

  it('exchanges bearer credentials for short-lived URL auth tokens', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const oldQueryReq = { method: 'GET', path: '/api/config/settings', url: '/api/config/settings?oc_client_token=client-token', headers: { accept: 'application/json' } };
    const oldQueryRes = createResponse();
    let oldQueryCalled = false;
    await auth.requireAuth(oldQueryReq, oldQueryRes, () => {
      oldQueryCalled = true;
    });
    expect(oldQueryCalled).toBe(false);
    expect(oldQueryRes.statusCode).toBe(401);

    const mintReq = { method: 'POST', path: '/auth/url-token', headers: { authorization: 'Bearer client-token', accept: 'application/json' } };
    const mintRes = createResponse();
    await auth.handleUrlAuthToken(mintReq, mintRes);
    expect(typeof mintRes.body.token).toBe('string');
    expect(mintRes.body.token.startsWith('oc_url_')).toBe(true);
    expect(mintRes.body.expiresAt).toBeGreaterThan(Date.now());
    expect(mintRes.getHeader('cache-control')).toBe('no-store');

    const urlToken = mintRes.body.token;
    const urlReq = { method: 'GET', path: '/api/fs/raw', url: `/api/fs/raw?path=%2Ftmp%2Fimage.png&oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const urlRes = createResponse();
    let urlCalled = false;
    await auth.requireAuth(urlReq, urlRes, () => {
      urlCalled = true;
    });
    expect(urlCalled).toBe(true);
    expect(await auth.ensureSessionToken(urlReq, urlRes)).toBe('client:device-1');
    expect(await auth.resolveAuthContext(urlReq, urlRes, { allowUrlToken: false })).toBe(null);

    // The session URL token no longer opens file previews: a preview page can
    // read its own URL, so it gets a narrow fs grant instead (see fs routes).
    for (const denied of [
      { method: 'GET', path: '/api/fs/serve/tmp/index.html', url: `/api/fs/serve/tmp/index.html?oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} },
      { method: 'GET', path: '/api/fs/preview/grant/tmp/index.html', url: `/api/fs/preview/grant/tmp/index.html?oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} },
    ]) {
      const deniedRes = createResponse();
      let deniedCalled = false;
      await auth.requireAuth(denied, deniedRes, () => {
        deniedCalled = true;
      });
      expect(deniedCalled).toBe(false);
      expect(deniedRes.statusCode).toBe(401);
    }

    const mountedRawReq = {
      method: 'GET',
      baseUrl: '/api',
      path: '/fs/raw',
      originalUrl: `/api/fs/raw?path=%2Ftmp%2Fimage.png&oc_url_token=${encodeURIComponent(urlToken)}`,
      url: `/fs/raw?path=%2Ftmp%2Fimage.png&oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: {},
    };
    const mountedRawRes = createResponse();
    let mountedRawCalled = false;
    await auth.requireAuth(mountedRawReq, mountedRawRes, () => {
      mountedRawCalled = true;
    });
    expect(mountedRawCalled).toBe(true);

    const guestReq = { method: 'GET', path: '/api/guests/hello/panel/index.html', url: `/api/guests/hello/panel/index.html?oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const guestRes = createResponse();
    let guestCalled = false;
    await auth.requireAuth(guestReq, guestRes, () => {
      guestCalled = true;
    });
    expect(guestCalled).toBe(true);

    // A guest-scoped token opens only that guest's files. It is the token a
    // sandboxed guest page can read from its own URL, so it must fail on every
    // system path and on another guest's files.
    const guestMintReq = { method: 'POST', path: '/auth/url-token', query: { scope: 'guest:hello' }, headers: { authorization: 'Bearer client-token', accept: 'application/json' } };
    const guestMintRes = createResponse();
    await auth.handleUrlAuthToken(guestMintReq, guestMintRes);
    const guestToken = guestMintRes.body.token;
    expect(typeof guestToken).toBe('string');
    const guestScopedReq = { method: 'GET', path: '/api/guests/hello/panel/main.js', url: `/api/guests/hello/panel/main.js?oc_url_token=${encodeURIComponent(guestToken)}`, headers: {} };
    let guestScopedCalled = false;
    await auth.requireAuth(guestScopedReq, createResponse(), () => {
      guestScopedCalled = true;
    });
    expect(guestScopedCalled).toBe(true);
    for (const forbidden of [
      { method: 'GET', path: '/api/fs/raw', url: `/api/fs/raw?path=%2Ftmp%2Fimage.png&oc_url_token=${encodeURIComponent(guestToken)}` },
      { method: 'GET', path: '/api/event', url: `/api/event?oc_url_token=${encodeURIComponent(guestToken)}` },
      { method: 'GET', path: '/api/guests/other/panel/main.js', url: `/api/guests/other/panel/main.js?oc_url_token=${encodeURIComponent(guestToken)}` },
      { method: 'GET', path: '/api/guests', url: `/api/guests?oc_url_token=${encodeURIComponent(guestToken)}` },
    ]) {
      const forbiddenRes = createResponse();
      let forbiddenCalled = false;
      await auth.requireAuth({ ...forbidden, headers: {} }, forbiddenRes, () => {
        forbiddenCalled = true;
      });
      expect(forbiddenCalled).toBe(false);
      expect(forbiddenRes.statusCode).toBe(401);
    }
    const badScopeRes = createResponse();
    await auth.handleUrlAuthToken({ ...guestMintReq, query: { scope: 'admin' } }, badScopeRes);
    expect(badScopeRes.statusCode).toBe(400);

    const dictationWsReq = {
      method: 'GET',
      path: '/api/dictation/ws',
      url: `/api/dictation/ws?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.ensureSessionToken(dictationWsReq, null)).toBe('client:device-1');

    // An extension surface socket takes the session-wide URL token, never a
    // guest-scoped one: it carries the user's pointer and keyboard.
    const surfaceWsReq = {
      method: 'GET',
      path: '/api/guests/server-chrome/surface/ws',
      url: `/api/guests/server-chrome/surface/ws?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.ensureSessionToken(surfaceWsReq, null)).toBe('client:device-1');
    expect(await auth.ensureSessionToken({ ...surfaceWsReq, url: `/api/guests/server-chrome/surface/ws?oc_url_token=${encodeURIComponent(guestToken)}` }, null)).toBe(null);
    expect(await auth.ensureSessionToken({
      ...surfaceWsReq,
      path: '/api/guests/server-chrome/surface/ws/extra',
      url: `/api/guests/server-chrome/surface/ws/extra?oc_url_token=${encodeURIComponent(urlToken)}`,
    }, null)).toBe(null);

    const devTunnelWsReq = {
      method: 'GET',
      path: '/api/dev-tunnel',
      url: `/api/dev-tunnel?port=4322&oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.ensureSessionToken(devTunnelWsReq, null)).toBe('client:device-1');

    // The sockets and the raw file of an isolated space, by path shape, and nothing else under the prefix.
    for (const socket of ['terminal/ws', 'dev-tunnel', 'event/ws', 'global/event/ws']) {
      const spaceWsReq = {
        method: 'GET',
        path: `/api/spaces/a1b2c3d4e5f6/${socket}`,
        url: `/api/spaces/a1b2c3d4e5f6/${socket}?oc_url_token=${encodeURIComponent(urlToken)}`,
        headers: { upgrade: 'websocket' },
      };
      expect(await auth.ensureSessionToken(spaceWsReq, null)).toBe('client:device-1');
    }
    expect(await auth.ensureSessionToken({
      method: 'GET',
      path: '/api/spaces/a1b2c3d4e5f6/dictation/ws',
      url: `/api/spaces/a1b2c3d4e5f6/dictation/ws?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    }, null)).toBe(null);
    expect(await auth.ensureSessionToken({
      method: 'GET',
      path: '/api/spaces/a1b2c3d4e5f6/fs/raw',
      url: `/api/spaces/a1b2c3d4e5f6/fs/raw?path=x.png&oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { accept: 'image/png' },
    }, null)).toBe('client:device-1');
    expect(await auth.ensureSessionToken({
      method: 'GET',
      path: '/api/spaces/a1b2c3d4e5f6/session',
      url: `/api/spaces/a1b2c3d4e5f6/session?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { accept: 'application/json' },
    }, null)).toBe(null);

    const devTunnelSubpathWsReq = {
      method: 'GET',
      path: '/api/dev-tunnel/private',
      url: `/api/dev-tunnel/private?port=4322&oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.ensureSessionToken(devTunnelSubpathWsReq, null)).toBe(null);

    const dictationHttpReq = {
      method: 'GET',
      path: '/api/dictation/ws',
      url: `/api/dictation/ws?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { accept: 'application/json' },
    };
    const dictationHttpRes = createResponse();
    let dictationHttpCalled = false;
    await auth.requireAuth(dictationHttpReq, dictationHttpRes, () => {
      dictationHttpCalled = true;
    });
    expect(dictationHttpCalled).toBe(false);
    expect(dictationHttpRes.statusCode).toBe(401);

    const arbitraryGetReq = { method: 'GET', path: '/api/config/settings', url: `/api/config/settings?oc_url_token=${encodeURIComponent(urlToken)}`, headers: { accept: 'application/json' } };
    const arbitraryGetRes = createResponse();
    let arbitraryGetCalled = false;
    await auth.requireAuth(arbitraryGetReq, arbitraryGetRes, () => {
      arbitraryGetCalled = true;
    });
    expect(arbitraryGetCalled).toBe(false);
    expect(arbitraryGetRes.statusCode).toBe(401);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const writeReq = { method, path: '/api/fs/raw', url: `/api/fs/raw?path=%2Ftmp%2Fimage.png&oc_url_token=${encodeURIComponent(urlToken)}`, headers: { accept: 'application/json' } };
      const writeRes = createResponse();
      let writeCalled = false;
      await auth.requireAuth(writeReq, writeRes, () => {
        writeCalled = true;
      });
      expect(writeCalled).toBe(false);
      expect(writeRes.statusCode).toBe(401);
    }
  });

  it('issues desktop client tokens with the UI session expiry', async () => {
    const createUiAuth = await loadCreateUiAuth();
    let createClientInput = null;
    const auth = createUiAuth({
      password: 'secret',
      sessionTtlMs: 123_000,
      clientAuthController: {
        createClient: async (input) => {
          createClientInput = input;
          return {
            token: 'client-token',
            client: {
              id: 'device-1',
              label: input.label ?? input.fallbackLabel,
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              revokedAt: null,
              expiresAt: input.expiresAt,
            },
          };
        },
      },
    });

    const before = Date.now();
    const req = {
      method: 'POST',
      headers: {},
      body: {
        password: 'secret',
        issueClientToken: true,
        clientLabel: 'OpenChamber Desktop',
      },
    };
    const res = createResponse();

    await auth.handleSessionCreate(req, res);

    expect(res.body.clientToken).toBe('client-token');
    expect(createClientInput.fallbackLabel).toBe('OpenChamber Desktop');
    const expiresAt = Date.parse(createClientInput.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 122_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 124_000);
  });

  it('gives a trusted device the trusted session lifetime', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret', sessionTtlMs: 60_000, trustedSessionTtlMs: 3_600_000 });
    const maxAgeFor = async (trustDevice) => {
      const res = createResponse();
      await auth.handleSessionCreate({ method: 'POST', headers: {}, body: { password: 'secret', trustDevice } }, res);
      return String(res.getHeader('set-cookie')).match(/Max-Age=(\d+)/i)?.[1];
    };
    expect(await maxAgeFor(false)).toBe('60');
    expect(await maxAgeFor(true)).toBe('3600');
  });

  it('reads login rate-limit attempt budgets from the environment', async () => {
    const { readRateLimitMaxAttempts } = await import('./ui-auth.js');
    expect(readRateLimitMaxAttempts('5', 10)).toBe(5);
    expect(readRateLimitMaxAttempts(' 12 ', 3)).toBe(12);
    for (const invalid of [undefined, '', 'abc', '0', '-5', '2.9', '1e3']) {
      expect(readRateLimitMaxAttempts(invalid, 10)).toBe(10);
      expect(readRateLimitMaxAttempts(invalid, 3)).toBe(3);
    }
  });

  it('reads session lifetimes from the environment', async () => {
    const { readSessionTtlMs } = await import('./ui-auth.js');
    expect(readSessionTtlMs('24', 1000, 5)).toBe(24_000);
    expect(readSessionTtlMs(' 0.5 ', 1000, 5)).toBe(500);
    for (const invalid of [undefined, '', 'abc', '0', '-3', '1e3', '0x10', '+12']) {
      expect(readSessionTtlMs(invalid, 1000, 5)).toBe(5);
    }
    // The bound is 400 days in ms: exactly that is accepted, past it the
    // value falls back instead of minting a non-expiring session.
    expect(readSessionTtlMs('400', 24 * 60 * 60 * 1000, 5)).toBe(400 * 24 * 60 * 60 * 1000);
    expect(readSessionTtlMs('401', 24 * 60 * 60 * 1000, 5)).toBe(5);
  });
});

// issue #2377: browsers key cookie jars on host only, so two instances on one
// LAN IP (different ports) collided on `oc_ui_session`. Cookies are now scoped
// by the request port so each instance owns its own slot.
describe('ui auth port-scoped session cookies (issue #2377)', () => {
  const loginHost = async (auth, host) => {
    const req = { method: 'POST', headers: { host }, body: { password: 'secret' } };
    const res = createResponse();
    await auth.handleSessionCreate(req, res);
    return String(res.getHeader('set-cookie') || '').split(';', 1)[0];
  };

  it('names the issued cookie with the request port', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });

    const issued = await loginHost(auth, '192.168.0.1:3000');
    expect(issued).toMatch(/^oc_ui_session_3000=/);
    expect(issued.length).toBeGreaterThan('oc_ui_session_3000='.length);
  });

  it('keeps the bare cookie name when the host has no explicit port', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });

    expect(await loginHost(auth, '192.168.0.1')).toMatch(/^oc_ui_session=/);
  });

  it('reads the slot for the request port and ignores another port cookie', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });

    // Valid token issued against :3000.
    const portCookie = await loginHost(auth, '192.168.0.1:3000');
    const validToken = portCookie.slice('oc_ui_session_3000='.length);

    // A request that lands on :3001 must read the :3001 slot, NOT the :3000 one,
    // even though the browser ships both cookies to either port.
    const wrongSlot = {
      method: 'GET',
      headers: { host: '192.168.0.1:3001', cookie: `oc_ui_session_3000=${validToken}; oc_ui_session_3001=stale` },
    };
    const wrongRes = createResponse();
    await auth.handleSessionStatus(wrongSlot, wrongRes);
    expect(wrongRes.body.authenticated).toBe(false);

    // The same token read on its own port authenticates.
    const rightSlot = {
      method: 'GET',
      headers: { host: '192.168.0.1:3000', cookie: `oc_ui_session_3000=${validToken}` },
    };
    const rightRes = createResponse();
    await auth.handleSessionStatus(rightSlot, rightRes);
    expect(rightRes.body.authenticated).toBe(true);
  });
});

describe('ui auth login rate limit', () => {
  it('keys failed logins on the connection, not on a client-chosen X-Forwarded-For', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });
    const attempt = async (index) => {
      // A rotated header is a deliberate spoof: without a trusted proxy in
      // front, Express leaves req.ip at the socket address.
      const req = {
        method: 'POST',
        ip: '198.51.100.7',
        headers: { host: '127.0.0.1:3000', 'x-forwarded-for': `203.0.113.${index}` },
        body: { password: 'wrong' },
      };
      const res = createResponse();
      await auth.handleSessionCreate(req, res);
      return res.statusCode;
    };

    const statuses = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push(await attempt(index));
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('counts rejected passkey assertions against the same budget as passwords', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });

    try {
      const statuses = [];
      for (let index = 0; index < 12; index += 1) {
        const req = {
          method: 'POST',
          ip: '198.51.100.99',
          headers: { host: '127.0.0.1:3000' },
          body: index % 2 === 0
            ? { response: { id: 'invalid-passkey-credential' } }
            : { password: 'wrong' },
        };
        const res = createResponse();
        if (index % 2 === 0) {
          await auth.handlePasskeyAuthenticationVerify(req, res);
        } else {
          await auth.handleSessionCreate(req, res);
        }
        statuses.push(res.statusCode);
      }

      expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      auth.dispose();
    }
  });

  it('does not let concurrent attempts exceed the per-IP failure budget', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });

    try {
      // 30 simultaneous wrong-password attempts from one IP against a
      // budget of 10: admission reserves each in-flight attempt, so
      // exactly 10 may fail with 401 and the rest are throttled --
      // before the fix, 14 were admitted (#2103).
      const attempt = async () => {
        const req = {
          method: 'POST',
          ip: '198.51.100.23',
          headers: { host: '127.0.0.1:3000' },
          body: { password: 'wrong' },
        };
        const res = createResponse();
        await auth.handleSessionCreate(req, res);
        return res.statusCode;
      };

      const statuses = await Promise.all(Array.from({ length: 30 }, () => attempt()));

      expect(statuses.filter((status) => status === 401)).toHaveLength(10);
      expect(statuses.filter((status) => status === 429)).toHaveLength(20);
    } finally {
      auth.dispose();
    }
  });
});

// issue #1778: the jwt-secret read is bounded and regular-file-checked.
// The secret file lives in the shared dataDir above; these cases manage
// its contents explicitly and run last in the file.
describe('ui auth jwt-secret bounded read (issue #1778)', () => {
  const secretPath = path.join(dataDir, 'jwt-secret');

  const login = async (auth) => {
    const res = createResponse();
    await auth.handleSessionCreate(
      { method: 'POST', headers: { host: '127.0.0.1' }, body: { password: 'secret' } },
      res,
    );
    return res;
  };

  it('honours a valid stored secret exactly (no regeneration)', async () => {
    const known = 'b'.repeat(64);
    fs.writeFileSync(secretPath, known + '\n', { mode: 0o600 });
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });
    const res = await login(auth);
    expect(res.getHeader('set-cookie')).toBeTruthy();
    expect(fs.readFileSync(secretPath, 'utf8')).toBe(known + '\n');
  });

  it('refuses an over-cap secret file and regenerates instead of using it as the key', async () => {
    fs.writeFileSync(secretPath, 'A'.repeat(1024 * 1024), { mode: 0o600 });
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });
    const res = await login(auth);
    expect(res.getHeader('set-cookie')).toBeTruthy();
    const persisted = fs.readFileSync(secretPath, 'utf8');
    expect(persisted).toMatch(/^[0-9a-f]{64}$/);
  });

  it('settles promptly with a FIFO at the secret path instead of freezing', async () => {
    fs.rmSync(secretPath, { force: true });
    execFileSync('mkfifo', [secretPath]);
    try {
      const createUiAuth = await loadCreateUiAuth();
      const auth = createUiAuth({ password: 'secret' });
      const res = await login(auth);
      expect(res.getHeader('set-cookie')).toBeTruthy();
      // The FIFO is left in place (never opened for write), and a later
      // call still settles.
      expect(fs.statSync(secretPath).isFIFO()).toBe(true);
      const again = createUiAuth({ password: 'secret' });
      expect(again).toBeTruthy();
    } finally {
      fs.rmSync(secretPath, { force: true });
      fs.writeFileSync(secretPath, 'c'.repeat(64), { mode: 0o600 });
    }
  });
});

// issue #1940: the jwt-secret write paths are judged on the opened handle,
// not by a by-path probe — rotation (global sign-out) must never block on a
// FIFO at the secret path, and the generate-and-persist write must not be
// re-openable by a swap between probe and write.
describe('ui auth jwt-secret handle-judged writes (issue #1940)', () => {
  const secretPath = path.join(dataDir, 'jwt-secret');

  it('rotates and persists a regular secret file with mode 0o600', async () => {
    fs.rmSync(secretPath, { force: true });
    fs.writeFileSync(secretPath, 'd'.repeat(64), { mode: 0o600 });
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });
    const res = createResponse();
    await auth.handleResetAuth({ method: 'POST', headers: { host: '127.0.0.1' } }, res);
    expect(res.body).toMatchObject({ cleared: true, signedOutEverywhere: true });
    const persisted = fs.readFileSync(secretPath, 'utf8');
    expect(persisted).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted).not.toBe('d'.repeat(64));
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    // The rotated secret serves the process: a login still succeeds.
    const loginRes = createResponse();
    await auth.handleSessionCreate(
      { method: 'POST', headers: { host: '127.0.0.1' }, body: { password: 'secret' } },
      loginRes,
    );
    expect(loginRes.getHeader('set-cookie')).toBeTruthy();
  });

  it('settles promptly when a FIFO replaces the secret file before rotation', async () => {
    fs.rmSync(secretPath, { force: true });
    fs.writeFileSync(secretPath, 'e'.repeat(64), { mode: 0o600 });
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });
    fs.rmSync(secretPath, { force: true });
    execFileSync('mkfifo', [secretPath]);
    try {
      const res = createResponse();
      await auth.handleResetAuth({ method: 'POST', headers: { host: '127.0.0.1' } }, res);
      expect(res.body).toMatchObject({ cleared: true, signedOutEverywhere: true });
      // The FIFO is left in place, and the rotated secret still serves the
      // process: a login still succeeds.
      expect(fs.statSync(secretPath).isFIFO()).toBe(true);
      const loginRes = createResponse();
      await auth.handleSessionCreate(
        { method: 'POST', headers: { host: '127.0.0.1' }, body: { password: 'secret' } },
        loginRes,
      );
      expect(loginRes.getHeader('set-cookie')).toBeTruthy();
    } finally {
      fs.rmSync(secretPath, { force: true });
      fs.writeFileSync(secretPath, 'c'.repeat(64), { mode: 0o600 });
    }
  });
});
