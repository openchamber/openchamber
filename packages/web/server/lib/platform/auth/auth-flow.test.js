// End-to-end platform auth flow against a FAKE in-test OIDC provider.
//
// The fake provider serves a real discovery document, JWKS and token endpoint
// and signs real RS256 id_tokens with jose; openid-client performs genuine
// signature/issuer/audience/expiry/nonce/PKCE validation against it. No real
// OIDC provider exists in this environment - real-provider verification is a
// deferred checklist item (plan section 7.1).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import request from 'supertest';
import { createHash } from 'node:crypto';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import { registerPlatformAuthRoutes } from './routes.js';
import { SESSION_COOKIE_NAME } from './sessions.js';

const CLIENT_ID = 'oc-web';
const silentLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

// --- fake OIDC provider -------------------------------------------------

async function createFakeOidcProvider() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const state = {
    issuer: null,
    privateKey,
    // Test hooks read at token-request time to build malformed id_tokens.
    signingKey: privateKey,
    idTokenIssuer: null, // null = use provider issuer
    idTokenAudience: CLIENT_ID,
    idTokenExpiration: '5m',
    codes: new Map(), // code -> { nonce, challenge, subject }
  };

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/.well-known/openid-configuration', (_req, res) => {
    const base = state.issuer;
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  app.get('/jwks', (_req, res) => {
    res.json({ keys: [jwk] });
  });

  // Auto-approves any authorization request: issues a code and redirects back.
  app.get('/authorize', (req, res) => {
    const code = `code-${state.codes.size + 1}`;
    state.codes.set(code, {
      nonce: String(req.query.nonce || ''),
      challenge: String(req.query.code_challenge || ''),
      subject: String(req.query.login_hint || 'subject-1'),
    });
    const target = new URL(String(req.query.redirect_uri));
    target.searchParams.set('code', code);
    target.searchParams.set('state', String(req.query.state || ''));
    res.redirect(302, target.toString());
  });

  app.post('/token', async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const pending = state.codes.get(code);
    if (!pending) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown code' });
    }
    state.codes.delete(code);

    // A real provider verifies PKCE; the fake provider does too so wrong-PKCE
    // flows fail at the token endpoint exactly like production.
    const verifier = String(req.body?.code_verifier || '');
    const challenge = createHash('sha256').update(verifier).digest().toString('base64url');
    if (challenge !== pending.challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    const idToken = await new SignJWT({ nonce: pending.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(pending.subject)
      .setIssuer(state.idTokenIssuer ?? state.issuer)
      .setAudience(state.idTokenAudience)
      .setIssuedAt()
      .setExpirationTime(state.idTokenExpiration)
      .sign(state.signingKey);

    res.json({
      access_token: 'fake-access-token',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  state.issuer = `http://127.0.0.1:${server.address().port}`;
  state.idTokenIssuer = state.issuer;

  const close = () => new Promise((resolve) => server.close(() => resolve()));
  return { app, server, state, close };
}

// --- platform app --------------------------------------------------------

async function createPlatformApp(db, providerState) {
  const app = express();
  app.set('trust proxy', true);
  const result = await registerPlatformAuthRoutes(app, {
    env: {
      OPENCHAMBER_PLATFORM_OIDC_ISSUER: providerState.issuer,
      OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: CLIENT_ID,
      OPENCHAMBER_PLATFORM_ALLOW_DEV_AUTH: 'true',
    },
    logger: silentLogger,
    db,
  });
  expect(result.enabled).toBe(true);
  return app;
}

const extractSessionCookie = (response) => {
  const cookies = response.headers['set-cookie'] || [];
  const raw = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  return raw ? raw.split(';')[0] : null;
};

// Drives the browser half of the flow: start login at the platform, follow
// the redirect against the fake provider, return the provider's callback URL.
async function authorizeWithProvider(platformApp, provider, { subject } = {}) {
  const login = await request(platformApp).get('/auth/login');
  expect(login.status).toBe(302);
  const authorizeUrl = new URL(login.headers.location);
  expect(authorizeUrl.pathname).toBe('/authorize');
  expect(authorizeUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
  expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorizeUrl.searchParams.get('scope')).toBe('openid');

  const providerResponse = await request(provider.app)
    .get(`${authorizeUrl.pathname}${authorizeUrl.search}`)
    .query(subject ? { login_hint: subject } : {});
  expect(providerResponse.status).toBe(302);
  return new URL(providerResponse.headers.location);
}

// --- tests ---------------------------------------------------------------

describe('platform auth flow (fake OIDC provider)', () => {
  let db;
  let provider;
  let platformApp;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await createTestPlatformDb();
    provider = await createFakeOidcProvider();
    platformApp = await createPlatformApp(db, provider.state);
  });

  afterEach(async () => {
    await provider?.close();
    await db?.end?.();
    provider = undefined;
    db = undefined;
  });

  const provisionUser = async (overrides = {}) => {
    const { user } = await importUser(db, {
      issuer: provider.state.issuer,
      subject: 'subject-1',
      displayName: 'User One',
      linuxUid: 1001,
      linuxGid: 1001,
      homePath: '/home/user1',
      ...overrides,
    });
    return user;
  };

  it('happy path: login -> callback -> me -> logout', async () => {
    const user = await provisionUser();

    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp).get(
      `${callbackUrl.pathname}${callbackUrl.search}`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/');
    const cookie = extractSessionCookie(callback);
    expect(cookie).toBeTruthy();

    // Cookie flags on a plain-http request: no Secure, but HttpOnly + SameSite=Lax.
    expect(cookie).not.toContain('Secure');
    const raw = callback.headers['set-cookie'].find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');

    const me = await request(platformApp).get('/api/platform/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
    expect(me.body.user.display_name).toBe('User One');
    expect(me.body.user.role).toBe('user');
    expect(me.body.user.linux_identity).toEqual({ bound: true });
    expect(me.body.locale).toBe('en');
    expect(me.body.capabilities).toContain('workspace.start');
    expect(me.body.workspace).toBeNull();
    // No internal binding values, credentials or endpoints leak (plan 7.3).
    const serialized = JSON.stringify(me.body);
    expect(serialized).not.toContain('/home/user1');
    expect(serialized).not.toContain('127.0.0.1:');

    // Audit trail: login success recorded against the user.
    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.auth.login'",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    expect(audits[0].target_user_id).toBe(user.id);

    // Logout requires the CSRF header.
    const noHeader = await request(platformApp).post('/auth/logout').set('Cookie', cookie);
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error).toBe('csrf_header_required');
    // Rejected CSRF attempt keeps the session alive.
    expect((await request(platformApp).get('/api/platform/me').set('Cookie', cookie)).status).toBe(200);

    const logout = await request(platformApp)
      .post('/auth/logout')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(logout.status).toBe(204);

    // The session is revoked: me now answers 401, and the DB row is revoked.
    const meAfter = await request(platformApp).get('/api/platform/me').set('Cookie', cookie);
    expect(meAfter.status).toBe(401);
    expect(meAfter.body.error).toBe('unauthenticated');
    const { rows: sessions } = await db.query('SELECT revoked_at FROM auth_sessions');
    expect(sessions[0].revoked_at).not.toBeNull();

    const { rows: logoutAudits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.auth.logout'",
    );
    expect(logoutAudits).toHaveLength(1);
    expect(logoutAudits[0].outcome).toBe('success');
  });

  it('sets the Secure cookie flag when the request arrives over https', async () => {
    await provisionUser();
    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp)
      .get(`${callbackUrl.pathname}${callbackUrl.search}`)
      .set('X-Forwarded-Proto', 'https');
    expect(callback.status).toBe(302);
    const raw = callback.headers['set-cookie'].find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(raw).toContain('Secure');
  });

  it('rejects an id_token with a bad signature', async () => {
    await provisionUser();
    provider.state.signingKey = (await generateKeyPair('RS256')).privateKey;

    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    expect(callback.status).toBe(401);
    expect(callback.body.error).toBe('invalid_id_token');
  });

  it('rejects an id_token with the wrong issuer', async () => {
    await provisionUser();
    provider.state.idTokenIssuer = 'http://attacker.example.com';

    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    expect(callback.status).toBe(401);
    expect(callback.body.error).toBe('invalid_id_token');
  });

  it('rejects an id_token with the wrong audience', async () => {
    await provisionUser();
    provider.state.idTokenAudience = 'some-other-client';

    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    expect(callback.status).toBe(401);
    expect(callback.body.error).toBe('invalid_id_token');
  });

  it('rejects an expired id_token', async () => {
    await provisionUser();
    provider.state.idTokenExpiration = '-30s';

    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    expect(callback.status).toBe(401);
    expect(callback.body.error).toBe('invalid_id_token');
  });

  it('rejects a replayed state (single-use login transactions)', async () => {
    await provisionUser();
    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const path = `${callbackUrl.pathname}${callbackUrl.search}`;

    const first = await request(platformApp).get(path);
    expect(first.status).toBe(302);
    const second = await request(platformApp).get(path);
    expect(second.status).toBe(401);
    expect(second.body.error).toBe('login_transaction_invalid');
  });

  it('rejects a callback with a wrong PKCE verifier', async () => {
    await provisionUser();
    const login = await request(platformApp).get('/auth/login');
    const authorizeUrl = new URL(login.headers.location);

    // Corrupt the stored verifier so the token endpoint's PKCE check fails,
    // exactly like a code interception attempt in production.
    await db.query(
      'UPDATE login_transactions SET code_verifier = $1 WHERE state = $2',
      ['a-completely-different-verifier-value-1234567890', authorizeUrl.searchParams.get('state')],
    );

    const providerResponse = await request(provider.app)
      .get(`${authorizeUrl.pathname}${authorizeUrl.search}`);
    const callbackUrl = new URL(providerResponse.headers.location);
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    expect(callback.status).toBe(401);
    expect(callback.body.error).toBe('invalid_id_token');
  });

  it('rejects a callback with a missing state', async () => {
    const callback = await request(platformApp).get('/auth/callback?code=x');
    expect(callback.status).toBe(401);
    expect(callback.body.error).toBe('login_transaction_invalid');
  });

  it('rejects an unknown (issuer, subject) without creating a session', async () => {
    const callbackUrl = await authorizeWithProvider(platformApp, provider, { subject: 'ghost' });
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    expect(callback.status).toBe(401);
    expect(callback.body.error).toBe('user_not_provisioned');
    expect(extractSessionCookie(callback)).toBeNull();
    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.auth.login'",
    );
    expect(audits[0].outcome).toBe('failure');
  });

  it('rejects a disabled user without creating a session', async () => {
    const user = await provisionUser();
    await db.query("UPDATE users SET status = 'disabled' WHERE id = $1", [user.id]);

    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    expect(callback.status).toBe(401);
    expect(callback.body.error).toBe('user_disabled');

    // A session row exists (the login was valid) but no cookie was issued.
    const { rows: sessions } = await db.query('SELECT * FROM auth_sessions');
    expect(sessions).toHaveLength(0);
  });

  it('answers 401 on me without a session cookie', async () => {
    const me = await request(platformApp).get('/api/platform/me');
    expect(me.status).toBe(401);
    expect(me.body.error).toBe('unauthenticated');
    expect(me.body.request_id).toBeTruthy();
  });

  it('answers 401 on me with a revoked session cookie', async () => {
    await provisionUser();
    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    const cookie = extractSessionCookie(callback);
    await request(platformApp)
      .post('/auth/logout')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest');
    const me = await request(platformApp).get('/api/platform/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
  });

  it('blocks an inactive user even with a still-valid session cookie', async () => {
    const user = await provisionUser();
    const callbackUrl = await authorizeWithProvider(platformApp, provider);
    const callback = await request(platformApp).get(`${callbackUrl.pathname}${callbackUrl.search}`);
    const cookie = extractSessionCookie(callback);

    await db.query("UPDATE users SET status = 'disabled' WHERE id = $1", [user.id]);
    const me = await request(platformApp).get('/api/platform/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
  });
});

describe('dev-auth gate on route registration', () => {
  let db;
  let provider;

  afterEach(async () => {
    await provider?.close();
    await db?.end?.();
    provider = undefined;
    db = undefined;
  });

  it('refuses startup with a loopback issuer and no kill switch (fail closed)', async () => {
    db = await createTestPlatformDb();
    provider = await createFakeOidcProvider();
    await expect(registerPlatformAuthRoutes(express(), {
      env: {
        OPENCHAMBER_PLATFORM_OIDC_ISSUER: provider.state.issuer,
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: CLIENT_ID,
      },
      logger: silentLogger,
      db,
    })).rejects.toThrow(/ALLOW_DEV_AUTH/);
  });

  it('starts with the kill switch and logs the loud dev-auth warning', async () => {
    db = await createTestPlatformDb();
    provider = await createFakeOidcProvider();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const app = express();
    const result = await registerPlatformAuthRoutes(app, {
      env: {
        OPENCHAMBER_PLATFORM_OIDC_ISSUER: provider.state.issuer,
        OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID: CLIENT_ID,
        OPENCHAMBER_PLATFORM_ALLOW_DEV_AUTH: 'true',
      },
      logger,
      db,
    });
    expect(result.enabled).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DEV AUTH IS ACTIVE'));
  });
});
