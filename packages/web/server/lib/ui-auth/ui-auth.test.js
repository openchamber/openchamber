import { afterAll, describe, expect, it } from 'bun:test';
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

    const serveReq = { method: 'GET', path: '/api/fs/serve/tmp/index.html', url: `/api/fs/serve/tmp/index.html?oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const serveRes = createResponse();
    let serveCalled = false;
    await auth.requireAuth(serveReq, serveRes, () => {
      serveCalled = true;
    });
    expect(serveCalled).toBe(true);

    const absoluteServeReq = { method: 'GET', path: '/api/fs/serve/Users/test/project/preview-test.html', url: `/api/fs/serve/Users/test/project/preview-test.html?oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const absoluteServeRes = createResponse();
    let absoluteServeCalled = false;
    await auth.requireAuth(absoluteServeReq, absoluteServeRes, () => {
      absoluteServeCalled = true;
    });
    expect(absoluteServeCalled).toBe(true);

    const mountedServeReq = {
      method: 'GET',
      baseUrl: '/api',
      path: '/fs/serve/Users/test/project/preview-test.html',
      originalUrl: `/api/fs/serve/Users/test/project/preview-test.html?oc_url_token=${encodeURIComponent(urlToken)}`,
      url: `/fs/serve/Users/test/project/preview-test.html?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: {},
    };
    const mountedServeRes = createResponse();
    let mountedServeCalled = false;
    await auth.requireAuth(mountedServeReq, mountedServeRes, () => {
      mountedServeCalled = true;
    });
    expect(mountedServeCalled).toBe(true);

    const dictationWsReq = {
      method: 'GET',
      path: '/api/dictation/ws',
      url: `/api/dictation/ws?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.ensureSessionToken(dictationWsReq, null)).toBe('client:device-1');

    const devTunnelWsReq = {
      method: 'GET',
      path: '/api/dev-tunnel',
      url: `/api/dev-tunnel?port=4322&oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.ensureSessionToken(devTunnelWsReq, null)).toBe('client:device-1');

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
    expect(issued).toStartWith('oc_ui_session_3000=');
    expect(issued.length).toBeGreaterThan('oc_ui_session_3000='.length);
  });

  it('keeps the bare cookie name when the host has no explicit port', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });

    expect(await loginHost(auth, '192.168.0.1')).toStartWith('oc_ui_session=');
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
