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
              label: input.label,
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
    expect(createClientInput.label).toBe('OpenChamber Desktop');
    const expiresAt = Date.parse(createClientInput.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 122_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 124_000);
  });
});
