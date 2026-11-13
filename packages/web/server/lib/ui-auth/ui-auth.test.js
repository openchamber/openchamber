import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import crypto from 'node:crypto';
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

describe('per-session sign-out', () => {
  const file = path.join(dataDir, 'ui-revoked-sessions.json');
  const controllers = [];
  const controller = async (options = {}) => {
    const auth = (await loadCreateUiAuth())({ password: 'secret', ...options });
    controllers.push(auth);
    return auth;
  };
  const req = (cookie) => ({ method: 'DELETE', path: '/api/test', headers: { cookie, accept: 'application/json' } });
  const login = async (auth) => {
    const res = createResponse();
    await auth.handleSessionCreate({ headers: {}, body: { password: 'secret' } }, res);
    expect(res.statusCode).toBe(200);
    return String(res.getHeader('set-cookie')).split(';')[0];
  };
  const allowed = async (auth, request) => {
    let passed = false;
    await auth.requireAuth(request, createResponse(), () => { passed = true; });
    return passed;
  };
  const mint = async (auth, request) => {
    const res = createResponse();
    await auth.handleUrlAuthToken(request, res);
    expect(res.statusCode).toBe(200);
    return { method: 'GET', path: '/api/fs/raw', query: { oc_url_token: res.body.token }, headers: { accept: 'application/json' } };
  };
  beforeEach(() => fs.rmSync(file, { recursive: true, force: true }));
  afterEach(() => {
    for (const auth of controllers.splice(0)) auth.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(file, { recursive: true, force: true });
    for (const name of fs.readdirSync(dataDir)) {
      if (name.startsWith('ui-revoked-sessions.json.unreadable-')) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
    }
  });

  it('case 1 revokes only cookie A and clears its cookie', async () => {
    const auth = await controller();
    const a = req(await login(auth));
    const b = req(await login(auth));
    const res = createResponse();
    await auth.handleSessionDelete(a, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ signedOut: true });
    expect(res.getHeader('set-cookie')).toContain('Max-Age=0');
    expect(await allowed(auth, a)).toBe(false);
    expect(await allowed(auth, b)).toBe(true);
  });
  it('case 2 invalidates only URL tokens from the signed-out session', async () => {
    const auth = await controller();
    const a = req(await login(auth));
    const urlA = await mint(auth, a);
    const urlB = await mint(auth, req(await login(auth)));
    await auth.handleSessionDelete(a, createResponse());
    expect(await allowed(auth, urlA)).toBe(false);
    expect(await allowed(auth, urlB)).toBe(true);
  });
  it('case 3 survives restart and prunes expired entries on load and write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    const auth = await controller({ sessionTtlMs: 1000 });
    const a = req(await login(auth));
    await auth.handleSessionDelete(a, createResponse());
    const restarted = await controller();
    expect(await allowed(restarted, a)).toBe(false);
    const b = req(await login(restarted));
    vi.setSystemTime(now + 2000);
    await restarted.handleSessionDelete(b, createResponse());
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.revoked).toHaveLength(1);
    expect(saved.revoked[0].expiresAt).toBeGreaterThan(Date.now());
    saved.revoked.push({ digest: 'a'.repeat(64), expiresAt: now - 1 });
    fs.writeFileSync(file, JSON.stringify(saved));
    const reloaded = await controller();
    await reloaded.handleSessionDelete(req(await login(reloaded)), createResponse());
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).revoked).toHaveLength(2);
  });
  it('case 4 revokes only the bearer client and its URL tokens', async () => {
    const { createRemoteClientAuthRuntime } = await import('../client-auth/remote-clients.js');
    const storePath = path.join(dataDir, 'task-2-clients.json');
    const clients = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto, storePath });
    try {
      const a = await clients.createClient({ label: 'A' });
      const b = await clients.createClient({ label: 'B' });
      const auth = await controller({ clientAuthController: clients });
      const requestA = { method: 'DELETE', headers: { authorization: `Bearer ${a.token}`, accept: 'application/json' } };
      const urlA = await mint(auth, requestA);
      const res = createResponse();
      await auth.handleSessionDelete(requestA, res);
      expect(res.body).toEqual({ signedOut: true });
      expect(await allowed(auth, requestA)).toBe(false);
      expect(await allowed(auth, { headers: { authorization: `Bearer ${b.token}` } })).toBe(true);
      expect(await allowed(auth, urlA)).toBe(false);
    } finally { fs.rmSync(storePath, { force: true }); }
  });
  it('case 5 works with an environment signing secret', async () => {
    const previous = process.env.OPENCODE_JWT_SECRET;
    process.env.OPENCODE_JWT_SECRET = 'synthetic-task-2-env-secret';
    try {
      const auth = await controller();
      const request = req(await login(auth));
      const res = createResponse();
      await auth.handleSessionDelete(request, res);
      expect(res.body).toEqual({ signedOut: true });
      expect(await allowed(auth, request)).toBe(false);
      const reset = createResponse();
      await auth.handleResetAuth(request, reset);
      expect(reset.statusCode).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_JWT_SECRET;
      else process.env.OPENCODE_JWT_SECRET = previous;
    }
  });
  it('case 6 reports disabled auth without signing out', async () => {
    const auth = await controller({ password: '' });
    const res = createResponse();
    await auth.handleSessionDelete({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ signedOut: false });
  });
  it('case 7 empties the persisted list on global sign-out', async () => {
    const auth = await controller();
    await auth.handleSessionDelete(req(await login(auth)), createResponse());
    const res = createResponse();
    await auth.handleResetAuth(req(await login(auth)), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, revoked: [] });
  });
  it('case 8 persists only digest and expiry with mode 600', async () => {
    const auth = await controller();
    const cookie = await login(auth);
    await auth.handleSessionDelete(req(cookie), createResponse());
    const token = cookie.split('=')[1];
    const { decodeJwt } = await import('jose');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, revoked: [{
      digest: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: decodeJwt(token).exp * 1000,
    }] });
    const mode = (fs.statSync(file).mode & 0o777).toString(8);
    console.log('task-2 revocation file mode:', mode);
    expect(mode).toBe('600');
  });
  it('gives same-second sign-ins distinct jti values and keeps B alive', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const auth = await controller();
    const a = await login(auth);
    const b = await login(auth);
    const { decodeJwt } = await import('jose');
    const payloadA = decodeJwt(a.split('=')[1]);
    const payloadB = decodeJwt(b.split('=')[1]);
    expect(payloadA.iat).toBe(payloadB.iat);
    expect(payloadA.exp).toBe(payloadB.exp);
    expect(payloadA.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(payloadA.jti).not.toBe(payloadB.jti);
    await auth.handleSessionDelete(req(a), createResponse());
    expect(await allowed(auth, req(a))).toBe(false);
    expect(await allowed(auth, req(b))).toBe(true);
  });
  it('accepts legacy JWTs without jti', async () => {
    const auth = await controller();
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(fs.readFileSync(path.join(dataDir, 'jwt-secret'), 'utf8').trim());
    const token = await new SignJWT({ type: 'ui-session' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('12h').sign(secret);
    expect(await allowed(auth, req(`oc_ui_session=${token}`))).toBe(true);
  });
  it('persists both concurrent sign-outs', async () => {
    const auth = await controller();
    const a = req(await login(auth));
    const b = req(await login(auth));
    await Promise.all([auth.handleSessionDelete(a, createResponse()), auth.handleSessionDelete(b, createResponse())]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).revoked).toHaveLength(2);
    const restarted = await controller();
    expect(await allowed(restarted, a)).toBe(false);
    expect(await allowed(restarted, b)).toBe(false);
  });
  it.each(['not-json-sensitive-sentinel', JSON.stringify({ version: 1, revoked: [{ digest: 'bad', expiresAt: 'never' }] }), null])('rotates UI sessions when the revocation list cannot load: %s', async (raw) => {
    // Given existing UI credentials and independent desktop client revocations.
    const { createRemoteClientAuthRuntime } = await import('../client-auth/remote-clients.js');
    const storePath = path.join(dataDir, 'recovery-clients.json');
    const clients = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto, storePath });
    const active = await clients.createClient({ label: 'Active' });
    const revoked = await clients.createClient({ label: 'Revoked' });
    await clients.revokeClient(revoked.client.id);
    const original = await controller({ clientAuthController: clients });
    const cookie = req(await login(original));
    const url = await mint(original, cookie);
    if (raw === null) fs.mkdirSync(file);
    else fs.writeFileSync(file, raw);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // When a new controller starts with unreadable revocation state.
    const restarted = await controller({ clientAuthController: clients });
    // Then old UI credentials fail, new login works and client state is unchanged.
    expect(await allowed(restarted, cookie)).toBe(false);
    expect(await allowed(restarted, url)).toBe(false);
    expect(await allowed(restarted, req(await login(restarted)))).toBe(true);
    expect(await allowed(restarted, { headers: { authorization: `Bearer ${active.token}`, accept: 'application/json' } })).toBe(true);
    expect(await allowed(restarted, { headers: { authorization: `Bearer ${revoked.token}`, accept: 'application/json' } })).toBe(false);
    const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith('ui-revoked-sessions.json.unreadable-'));
    expect(backups).toHaveLength(1);
    if (raw === null) expect(fs.statSync(path.join(dataDir, backups[0])).isDirectory()).toBe(true);
    else expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe(raw);
    expect(error).toHaveBeenCalledTimes(1);
    if (raw !== null) expect(JSON.stringify(error.mock.calls)).not.toContain(raw);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, revoked: [] });
    fs.rmSync(storePath, { force: true });
  });

  it('logs the pinned-secret exception and retains existing UI sessions', async () => {
    // Given a pinned key and corrupt revocation file.
    const previous = process.env.OPENCODE_JWT_SECRET;
    process.env.OPENCODE_JWT_SECRET = 'synthetic-recovery-pinned-key';
    try {
      const original = await controller();
      const cookie = req(await login(original));
      fs.writeFileSync(file, 'corrupt-sensitive-sentinel');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      // When recovery cannot rotate the configured key.
      const restarted = await controller();
      // Then the documented exception is logged without payload contents.
      expect(await allowed(restarted, cookie)).toBe(true);
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).toContain('OPENCODE_JWT_SECRET');
      expect(JSON.stringify(error.mock.calls)).toContain('until they expire');
      expect(JSON.stringify(error.mock.calls)).not.toContain('corrupt-sensitive-sentinel');
      const response = createResponse();
      await restarted.handleSessionDelete(cookie, response);
      expect(response.statusCode).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_JWT_SECRET;
      else process.env.OPENCODE_JWT_SECRET = previous;
    }
  });

  it('gates authentication and sign-in until startup recovery persists', async () => {
    // Given an old cookie and recovery paused before the replacement rename.
    const original = await controller();
    const cookie = req(await login(original));
    fs.writeFileSync(file, 'corrupt');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = Promise.withResolvers();
    const started = Promise.withResolvers();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      started.resolve();
      await release.promise;
      return rename(...args);
    });
    const restarted = await controller();
    await started.promise;
    let authenticated = false;
    let signedIn = false;
    const validation = allowed(restarted, cookie).then((result) => { authenticated = true; return result; });
    const signIn = login(restarted).then((result) => { signedIn = true; return result; });
    try {
      // When requests arrive before the durable recovery completes.
      await new Promise(setImmediate);
      // Then neither validation nor issuance completes before persistence.
      expect(authenticated).toBe(false);
      expect(signedIn).toBe(false);
    } finally {
      release.resolve();
      await Promise.all([validation, signIn]);
    }
    expect(await validation).toBe(false);
    expect(await allowed(restarted, req(await signIn))).toBe(true);
  });

  it('rotates sessions even when moving the unreadable file aside fails', async () => {
    // Given corruption that cannot be renamed for quarantine.
    const original = await controller();
    const cookie = req(await login(original));
    fs.writeFileSync(file, 'corrupt');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic rename failure'); });
    // When the controller recovers.
    const restarted = await controller();
    // Then rotation still rejects the old cookie and permits a fresh sign-in.
    expect(await allowed(restarted, cookie)).toBe(false);
    expect(await allowed(restarted, req(await login(restarted)))).toBe(true);
  });

  it('retains unreadable revocations when key rotation fails and retries on restart', async () => {
    // Given a revoked cookie, corrupt state and a readable but unwritable key.
    const original = await controller();
    const cookie = req(await login(original));
    await original.handleSessionDelete(cookie, createResponse());
    const raw = 'corrupt-sensitive-sentinel';
    fs.writeFileSync(file, raw);
    const secretFile = path.join(dataDir, 'jwt-secret');
    const mode = fs.statSync(secretFile).mode & 0o777;
    fs.chmodSync(secretFile, 0o400);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // When recovery cannot persist a new signing key.
      const failed = await controller();
      const response = createResponse();
      await expect(failed.handleSessionCreate({ headers: {}, body: { password: 'secret' } }, response)).rejects.toMatchObject({ code: 'EACCES' });
      // Then no credentials work, the input remains and failure is reported safely.
      expect(await allowed(failed, cookie)).toBe(false);
      expect(response.getHeader('set-cookie')).toBeUndefined();
      expect(fs.readFileSync(file, 'utf8')).toBe(raw);
      expect(fs.readdirSync(dataDir).filter((name) => name.startsWith('ui-revoked-sessions.json.unreadable-'))).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/\(EACCES\)/));
      expect(JSON.stringify(error.mock.calls)).not.toContain(raw);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secretFile);
    } finally {
      fs.chmodSync(secretFile, mode);
    }
    // Given restored write permission, when another controller starts.
    const recovered = await controller();
    // Then recovery rotates before quarantine and accepts only a new UI session.
    expect(await allowed(recovered, cookie)).toBe(false);
    expect(await allowed(recovered, req(await login(recovered)))).toBe(true);
    const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith('ui-revoked-sessions.json.unreadable-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe(raw);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, revoked: [] });
  });

  it('refuses to overwrite invalid revocations introduced after startup', async () => {
    // Given valid credentials and a file corrupted by another writer.
    const auth = await controller();
    const request = req(await login(auth));
    const raw = JSON.stringify({ version: 2, revoked: [] });
    fs.writeFileSync(file, raw);
    // When this session signs out.
    const response = createResponse();
    await auth.handleSessionDelete(request, response);
    // Then failure preserves both disk contents and current session validity.
    expect(response.statusCode).toBe(500);
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(await allowed(auth, request)).toBe(true);
  });

  it('merges revocations persisted by an independently started writer', async () => {
    // Given two controllers started before either writes.
    const first = await controller();
    const second = await controller();
    const a = req(await login(first));
    const b = req(await login(second));
    await first.handleSessionDelete(a, createResponse());
    // When the second controller signs out another session.
    await second.handleSessionDelete(b, createResponse());
    // Then both revocations survive another restart.
    const restarted = await controller();
    expect(await allowed(restarted, a)).toBe(false);
    expect(await allowed(restarted, b)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).revoked).toHaveLength(2);
  });
  it('refuses missing, garbage and malformed credentials', async () => {
    const auth = await controller();
    for (const headers of [{}, { cookie: 'oc_ui_session=%broken' }, { authorization: 'Bearer' }]) {
      const res = createResponse();
      await auth.handleSessionDelete({ path: '/api/test', headers: { ...headers, accept: 'application/json' } }, res);
      expect(res.statusCode).toBe(401);
    }
  });
  it('reports failed persistence without success and permits retry', async () => {
    const auth = await controller();
    const request = req(await login(auth));
    fs.mkdirSync(file);
    const res = createResponse();
    await auth.handleSessionDelete(request, res);
    expect(res.statusCode).toBe(500);
    expect(await allowed(auth, request)).toBe(true);
    fs.rmSync(file, { recursive: true });
    const retry = createResponse();
    await auth.handleSessionDelete(request, retry);
    expect(retry.body).toEqual({ signedOut: true });
    expect(await allowed(auth, request)).toBe(false);
    expect(fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('cannot sign out with only a URL token', async () => {
    const auth = await controller();
    const request = req(await login(auth));
    const url = await mint(auth, request);
    const res = createResponse();
    await auth.handleSessionDelete(url, res);
    expect(res.statusCode).toBe(401);
    expect(await allowed(auth, request)).toBe(true);
  });

  it('prefers a valid cookie over an accompanying bearer client', async () => {
    const { createRemoteClientAuthRuntime } = await import('../client-auth/remote-clients.js');
    const storePath = path.join(dataDir, 'task-2-precedence-clients.json');
    const clients = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto, storePath });
    try {
      const client = await clients.createClient({ label: 'Unrelated client' });
      const auth = await controller({ clientAuthController: clients });
      const request = req(await login(auth));
      await auth.handleSessionDelete({ ...request, headers: { ...request.headers, authorization: `Bearer ${client.token}` } }, createResponse());
      expect(await allowed(auth, request)).toBe(false);
      expect(await allowed(auth, { headers: { authorization: `Bearer ${client.token}` } })).toBe(true);
    } finally { fs.rmSync(storePath, { force: true }); }
  });
});

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
    expect(mintRes.body.expiresIn).toBe(60_000);
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
    // A provider's uploads take the URL token only where its descriptor says it serves uploads.
    const uploadOf = (provider) => ({
      method: 'GET',
      path: `/api/source-control/${provider}/uploads/abc/clip.png`,
      url: `/api/source-control/${provider}/uploads/abc/clip.png?owner=o&repo=r&oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { accept: 'image/png' },
    });
    expect(await auth.ensureSessionToken(uploadOf('gitlab'), null)).toBe('client:device-1');
    expect(await auth.ensureSessionToken(uploadOf('github'), null)).toBe(null);
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

  it('reads session lifetimes from the environment', async () => {
    const { readSessionTtlMs } = await import('./ui-auth.js');
    expect(readSessionTtlMs('24', 1000, 5)).toBe(24_000);
    expect(readSessionTtlMs(' 0.5 ', 1000, 5)).toBe(500);
    for (const invalid of [undefined, '', 'abc', '0', '-3']) {
      expect(readSessionTtlMs(invalid, 1000, 5)).toBe(5);
    }
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
});

describe('ui auth with OPENCHAMBER_UI_PASSWORD_HASH', () => {
  const login = async (auth, candidate) => {
    const res = createResponse();
    await auth.handleSessionCreate({ method: 'POST', headers: {}, body: { password: candidate } }, res);
    return res;
  };

  it('logs in with the password matching the configured hash', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const { hashUiPassword } = await import('./ui-password-hash.js');
    const auth = createUiAuth({ passwordHash: hashUiPassword('correct horse') });

    const res = await login(auth, '  correct horse  ');

    expect(auth.enabled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.getHeader('set-cookie') || '').startsWith('oc_ui_session=')).toBe(true);
  });

  it('rejects a wrong password against the configured hash', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const { hashUiPassword } = await import('./ui-password-hash.js');
    const auth = createUiAuth({ passwordHash: hashUiPassword('correct horse') });

    const res = await login(auth, 'battery staple');

    expect(res.statusCode).toBe(401);
  });

  it('prefers the hash over a plaintext password when both are configured', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const { hashUiPassword } = await import('./ui-password-hash.js');
    const auth = createUiAuth({ password: 'plaintext-one', passwordHash: hashUiPassword('hashed-one') });

    expect((await login(auth, 'plaintext-one')).statusCode).toBe(401);
  });

  it('fails closed on a malformed hash instead of disabling auth', async () => {
    const createUiAuth = await loadCreateUiAuth();

    expect(() => createUiAuth({ passwordHash: 'scrypt$bad' })).toThrow(/malformed/);
  });
});
