import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  startAuthorization,
  consumeAuthorizationCallback,
  pollAuthorizationBroker,
  completeAuthorizationBroker,
  refreshAccessToken,
  clearPendingAuthorizationsForTests,
} from './oauth.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-linear-oauth-'));

describe('Linear OAuth PKCE', () => {
  let dataDir;
  let previousDataDir;
  let previousPort;
  let previousRedirect;

  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    previousPort = process.env.OPENCHAMBER_PORT;
    previousRedirect = process.env.OPENCHAMBER_LINEAR_REDIRECT_URI;
    dataDir = makeTempDir();
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.OPENCHAMBER_PORT = '3001';
    delete process.env.OPENCHAMBER_LINEAR_CLIENT_ID;
    process.env.OPENCHAMBER_LINEAR_REDIRECT_URI = 'http://127.0.0.1:3001/linear/oauth/callback';
    clearPendingAuthorizationsForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearPendingAuthorizationsForTests();
    restoreEnv('OPENCHAMBER_DATA_DIR', previousDataDir);
    restoreEnv('OPENCHAMBER_PORT', previousPort);
    restoreEnv('OPENCHAMBER_LINEAR_REDIRECT_URI', previousRedirect);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates an S256 authorize URL and stores a pending verifier', async () => {
    const started = await startAuthorization({ origin: 'desktop' });
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('91bbe26a69a2c8568d3683f1e01e776c');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3001/linear/oauth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('actor')).toBe('user');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(started.scope).toBe('read,write,comments:create');
    expect(started.expiresIn).toBe(600);
  });

  it('refuses a callback whose state was never started', async () => {
    const tokenFetch = vi.fn();
    vi.stubGlobal('fetch', tokenFetch);
    await expect(consumeAuthorizationCallback({
      code: 'attacker-code',
      state: 'forged',
    })).rejects.toMatchObject({ code: 'UNKNOWN_STATE' });
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('exchanges a matching code with the original PKCE verifier', async () => {
    const started = await startAuthorization({ origin: 'web' });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const tokenFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 86399,
      scope: 'read,write,comments:create',
    }), { status: 200 }));
    vi.stubGlobal('fetch', tokenFetch);

    const result = await consumeAuthorizationCallback({ code: 'auth-code', state });
    expect(result.accessToken).toBe('access-1');
    expect(result.refreshToken).toBe('refresh-1');
    expect(result.origin).toBe('web');

    expect(tokenFetch).toHaveBeenCalledTimes(1);
    const [url, init] = tokenFetch.mock.calls[0];
    expect(String(url)).toBe('https://api.linear.app/oauth/token');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.get('client_secret')).toBeNull();

    await expect(consumeAuthorizationCallback({ code: 'auth-code', state })).rejects.toMatchObject({
      code: 'UNKNOWN_STATE',
    });
  });

  it('persists a rotated refresh token from Linear', async () => {
    const tokenFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      token_type: 'Bearer',
      expires_in: 86399,
    }), { status: 200 }));
    vi.stubGlobal('fetch', tokenFetch);
    const tokens = await refreshAccessToken('refresh-1');
    expect(tokens.accessToken).toBe('access-2');
    expect(tokens.refreshToken).toBe('refresh-2');
    const body = new URLSearchParams(tokenFetch.mock.calls[0][1].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('claims a broker callback and exchanges it locally with PKCE', async () => {
    delete process.env.OPENCHAMBER_LINEAR_REDIRECT_URI;
    const brokerAndTokenFetch = vi.fn(async (url, init) => {
      const target = String(url);
      if (target.endsWith('/start')) {
        const body = JSON.parse(init.body);
        expect(body.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(body.claimSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return new Response(JSON.stringify({
          redirectUri: 'https://api.openchamber.dev/v1/oauth/linear/callback',
          expiresIn: 600,
        }), { status: 200 });
      }
      if (target.endsWith('/poll')) {
        return new Response(JSON.stringify({ status: 'complete', code: 'broker-code' }), { status: 200 });
      }
      if (target.endsWith('/complete')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (target === 'https://api.linear.app/oauth/token') {
        const body = new URLSearchParams(init.body);
        expect(body.get('code')).toBe('broker-code');
        expect(body.get('redirect_uri')).toBe('https://api.openchamber.dev/v1/oauth/linear/callback');
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return new Response(JSON.stringify({
          access_token: 'broker-access',
          refresh_token: 'broker-refresh',
          expires_in: 86399,
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal('fetch', brokerAndTokenFetch);

    const started = await startAuthorization({ origin: 'desktop' });
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('https://api.openchamber.dev/v1/oauth/linear/callback');

    const result = await pollAuthorizationBroker();
    expect(result).toMatchObject({ accessToken: 'broker-access', origin: 'desktop' });
    await expect(completeAuthorizationBroker(result.brokerReceipt)).resolves.toBe(true);
    expect(brokerAndTokenFetch).toHaveBeenCalledTimes(4);
  });
});

function restoreEnv(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
