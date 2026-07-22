/**
 * Reproduction test for issue #2377
 * 
 * Bug: Session cookie collision when multiple instances share the same IP address
 * 
 * When two OpenChamber instances run on the same IP (different ports), both set
 * a cookie named 'oc_ui_session'. Browsers do not scope cookies by port for IP
 * addresses, so the second instance's cookie overwrites the first instance's cookie,
 * breaking session auth.
 * 
 * Root cause: SESSION_COOKIE_NAME is hardcoded as 'oc_ui_session' with no env var
 * override. There is no way to give each instance a unique cookie name.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Temp dirs for each instance (simulating separate config dirs like ~/.config/openchamber)
const instanceADir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-instance-A-'));
const instanceBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-instance-B-'));

let originalDataDir;

beforeAll(() => {
  originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
});

afterAll(() => {
  if (originalDataDir !== undefined) {
    process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
  } else {
    delete process.env.OPENCHAMBER_DATA_DIR;
  }
  fs.rmSync(instanceADir, { recursive: true, force: true });
  fs.rmSync(instanceBDir, { recursive: true, force: true });
  // Clean up any generated jwt-secret from root data dir during test runs
  try {
    const rootDataDir = process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), '.config', 'openchamber');
    const jwtFile = path.join(rootDataDir, 'jwt-secret');
    if (fs.existsSync(jwtFile)) fs.rmSync(jwtFile);
  } catch {}
});

/**
 * Helper: create a mock request object
 */
const mockRequest = (cookie, options = {}) => {
  const { host = '192.168.0.1:3000', pathname = '/', method = 'GET' } = options;
  const headers = { host };
  if (cookie) headers.cookie = cookie;
  if (method === 'POST') headers['content-type'] = 'application/json';
  return {
    method,
    path: pathname,
    url: pathname,
    headers,
    connection: { remoteAddress: '192.168.0.1' },
  };
};

/**
 * Helper: create a mock response object
 */
const mockResponse = () => {
  const headers = new Map();
  let responseBody = null;
  let responseStatus = 200;
  let contentType = null;
  return {
    status(code) { responseStatus = code; return this; },
    json(payload) { responseBody = payload; return this; },
    type(t) { contentType = t; return this; },
    send(t) { responseBody = t; return this; },
    setHeader(name, value) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    get statusCode() { return responseStatus; },
    get body() { return responseBody; },
  };
};

// We need to load the module fresh for each instance to avoid JWT secret caching
const loadUiAuthWithDataDir = async (dataDir) => {
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  // Use a fresh import with a unique query param to avoid module caching
  const timestamp = Date.now();
  const mod = await import(`./ui-auth.js?v=${timestamp}`);
  return mod.createUiAuth;
};

describe('Issue #2377 - Session cookie collision (reproduction)', () => {
  it('SESSION_COOKIE_NAME is hardcoded with NO env var override (root cause)', async () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, 'ui-auth.js'),
      'utf8'
    );

    // Find the SESSION_COOKIE_NAME declaration
    const sessionCookieLine = source.split('\n').find(l => l.includes('SESSION_COOKIE_NAME'));
    expect(sessionCookieLine).toBeDefined();
    
    // It's hardcoded with no process.env fallback
    expect(sessionCookieLine).toMatch(/SESSION_COOKIE_NAME\s*=\s*'oc_ui_session'/);
    expect(sessionCookieLine).not.toMatch(/process\.env/);
    
    // The proposed fix would add process.env.OPENCHAMBER_SESSION_COOKIE_NAME
  });

  it('two instances on same IP produce cookies with the SAME name -> collision', async () => {
    // Load ui-auth module fresh for instance A (separate data dir = separate JWT secret)
    const createUiAuthA = await loadUiAuthWithDataDir(instanceADir);
    const authA = createUiAuthA({ password: 'pass-A' });
    expect(authA.enabled).toBe(true);

    // Load ui-auth module fresh for instance B (different data dir = different JWT secret)  
    const createUiAuthB = await loadUiAuthWithDataDir(instanceBDir);
    const authB = createUiAuthB({ password: 'pass-B' });
    expect(authB.enabled).toBe(true);

    // --- Step 1: Log into instance A on port 3000 ---
    const loginReqA = mockRequest(null, { host: '192.168.0.1:3000', method: 'POST', pathname: '/auth/session' });
    loginReqA.body = { password: 'pass-A' };
    const loginResA = mockResponse();
    await authA.handleSessionCreate(loginReqA, loginResA);
    
    const setCookieA = loginResA.getHeader('set-cookie');
    expect(setCookieA).toBeDefined();
    expect(setCookieA).toMatch(/^oc_ui_session=/);
    
    // Parse the cookie name and value
    const cookiePartsA = setCookieA.split(';')[0].split('=');
    const cookieNameA = cookiePartsA[0];
    const cookieValueA = cookiePartsA.slice(1).join('=');

    expect(cookieNameA).toBe('oc_ui_session');

    // --- Step 2: Log into instance B on port 3001 ---
    const loginReqB = mockRequest(null, { host: '192.168.0.1:3001', method: 'POST', pathname: '/auth/session' });
    loginReqB.body = { password: 'pass-B' };
    const loginResB = mockResponse();
    await authB.handleSessionCreate(loginReqB, loginResB);

    const setCookieB = loginResB.getHeader('set-cookie');
    expect(setCookieB).toBeDefined();
    expect(setCookieB).toMatch(/^oc_ui_session=/);

    const cookiePartsB = setCookieB.split(';')[0].split('=');
    const cookieNameB = cookiePartsB[0];
    const cookieValueB = cookiePartsB.slice(1).join('=');

    // BOTH cookies have the name 'oc_ui_session' — SAME name, DIFFERENT values
    expect(cookieNameB).toBe('oc_ui_session');
    expect(cookieNameB).toBe(cookieNameA);
    expect(cookieValueB).not.toBe(cookieValueA);

    // --- Step 3: Simulate browser behavior ---
    // Browser stores only ONE cookie named 'oc_ui_session' for host 192.168.0.1
    // (cookies are NOT scoped by port for IP addresses in most browsers)
    // Instance B's login overwrites instance A's cookie.
    // Now the browser sends cookieValueB to BOTH instances.

    // Simulate browser sending cookie value B to instance A (stale/overwritten cookie)
    // Use an /api path with JSON accept to get structured error response
    const staleReq = mockRequest(`oc_ui_session=${encodeURIComponent(cookieValueB)}`, {
      host: '192.168.0.1:3000',
      pathname: '/api/session/status',
    });
    staleReq.headers.accept = 'application/json';
    const staleRes = mockResponse();
    let authAPassed = false;
    await authA.requireAuth(staleReq, staleRes, () => { authAPassed = true; });

    // Instance A rejects instance B's token because JWT secrets differ
    expect(authAPassed).toBe(false);
    expect(staleRes.statusCode).toBe(401);
    expect(staleRes.body).toEqual({ error: 'UI authentication required', locked: true });

    // --- Step 4: Verify the servers themselves are fine (cookie B works for instance B) ---
    const validReq = mockRequest(`oc_ui_session=${encodeURIComponent(cookieValueB)}`, {
      host: '192.168.0.1:3001',
      pathname: '/api/session/status',
    });
    validReq.headers.accept = 'application/json';
    const validRes = mockResponse();
    let authBPassed = false;
    await authB.requireAuth(validReq, validRes, () => { authBPassed = true; });
    expect(authBPassed).toBe(true);

    // CONFIRMATION: The bug is that instance A cannot authenticate despite being
    // logged in, because its cookie was overwritten by instance B's login.
    // Both servers are healthy - verified above.
  });

  it('cookieName parameter exists but is never passed by callers or exposed via env', async () => {
    // The createUiAuth function accepts `cookieName` as a parameter (line 409):
    //   cookieName = SESSION_COOKIE_NAME,
    // But callers don't pass it. See bootstrap-runtime.js line 64:
    //   createUiAuth({ password, readSettingsFromDiskMigrated, clientAuthController })
    // And there is no env var plumbing to set it.

    // Verify the parameter works if passed explicitly (showing the API supports it,
    // but there's no way to configure it externally)
    const createUiAuth = await loadUiAuthWithDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-custom-cookie-')));
    const auth = createUiAuth({
      password: 'secret',
      cookieName: 'oc_ui_session_instance_A',
    });

    const req = mockRequest(null, { host: '192.168.0.1:3000', method: 'POST', pathname: '/auth/session' });
    req.body = { password: 'secret' };
    const res = mockResponse();
    await auth.handleSessionCreate(req, res);

    const setCookie = res.getHeader('set-cookie');
    expect(setCookie).toMatch(/^oc_ui_session_instance_A=/);
    
    // Verify it's NOT 'oc_ui_session' (the default)
    expect(setCookie).not.toMatch(/^oc_ui_session=/);
  });
});
