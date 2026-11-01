import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTrackerOAuth, oauthTargetOf, resolveOAuthEndpoint, trackerRedirectUri } from './extension-oauth.js';

describe('tracker OAuth', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves endpoints against the instance only when they are paths, and names the callback', () => {
    expect(resolveOAuthEndpoint('/hub/api/rest/oauth2/auth', 'https://yt.example.com')).toBe('https://yt.example.com/hub/api/rest/oauth2/auth');
    expect(resolveOAuthEndpoint('https://auth.atlassian.com/authorize', 'https://acme.atlassian.net')).toBe('https://auth.atlassian.com/authorize');
    expect(oauthTargetOf({ authorizeUrl: '/a', tokenUrl: 'https://t.example/t' }, 'https://yt.example.com')).toEqual({ authorizeUrl: 'https://yt.example.com/a', tokenUrl: 'https://t.example/t' });
    expect(trackerRedirectUri('https://app.example.com/', 'ext-youtrack')).toBe('https://app.example.com/api/tracker/ext-youtrack/oauth/callback');
  });

  it('starts a PKCE sign-in under a fresh state, takes it once, and forgets an expired or replaced one', () => {
    let clock = 1_000;
    const oauth = createTrackerOAuth({ now: () => clock });
    const target = { authorizeUrl: 'https://yt.example.com/hub/auth', tokenUrl: 'https://yt.example.com/hub/token' };
    const connection = Symbol('connect');
    const started = oauth.start({ providerId: 'ext-yt', instance: 'https://yt.example.com', client: { id: 'client-1', secret: '' }, target, scopes: ['YouTrack'], redirectUri: 'https://app.example.com/api/tracker/ext-yt/oauth/callback', connection });
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://yt.example.com/hub/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'client-1', redirect_uri: 'https://app.example.com/api/tracker/ext-yt/oauth/callback', code_challenge_method: 'S256', scope: 'YouTrack',
    });
    const state = url.searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(started.expiresIn).toBe(600);

    // Another provider cannot take it; a wrong or missing state is nothing.
    expect(oauth.take({ providerId: 'ext-other', state })).toBeNull();
    expect(oauth.take({ providerId: 'ext-yt', state: 'nope' })).toBeNull();
    expect(oauth.take({ providerId: 'ext-yt', state: '' })).toBeNull();
    const pending = oauth.take({ providerId: 'ext-yt', state });
    expect(pending).toMatchObject({ providerId: 'ext-yt', instance: 'https://yt.example.com', target, connection, client: { id: 'client-1' } });
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // Taken once.
    expect(oauth.take({ providerId: 'ext-yt', state })).toBeNull();

    // A second start replaces the first; an expired start is gone.
    const first = new URL(oauth.start({ providerId: 'ext-yt', instance: 'https://yt.example.com', client: { id: 'c' }, target, scopes: [], redirectUri: 'r', connection }).authorizationUrl).searchParams.get('state');
    const second = new URL(oauth.start({ providerId: 'ext-yt', instance: 'https://yt.example.com', client: { id: 'c' }, target, scopes: [], redirectUri: 'r', connection }).authorizationUrl).searchParams.get('state');
    expect(oauth.take({ providerId: 'ext-yt', state: first })).toBeNull();
    clock += 11 * 60_000;
    expect(oauth.take({ providerId: 'ext-yt', state: second })).toBeNull();
    const third = new URL(oauth.start({ providerId: 'ext-yt', instance: 'https://yt.example.com', client: { id: 'c' }, target, scopes: [], redirectUri: 'r', connection }).authorizationUrl).searchParams.get('state');
    oauth.dropProvider('ext-yt');
    expect(oauth.take({ providerId: 'ext-yt', state: third })).toBeNull();
  });

  it('exchanges the code at the pending target with the verifier, and refreshes with the client', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      seen.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init.body)) });
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const oauth = createTrackerOAuth({ now: () => 1_000 });
    const target = { authorizeUrl: 'https://yt.example.com/hub/auth', tokenUrl: 'https://yt.example.com/hub/token' };
    const tokens = await oauth.exchange({ target, redirectUri: 'https://app/cb', client: { id: 'client-1', secret: 's3' }, verifier: 'v' }, 'code-1');
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', tokenType: 'bearer' });
    expect(tokens.expiresAt).toBe(Date.now() > 0 ? tokens.expiresAt : 0);
    expect(seen[0]).toEqual({
      url: 'https://yt.example.com/hub/token',
      body: { grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://app/cb', client_id: 'client-1', client_secret: 's3', code_verifier: 'v' },
    });
    await oauth.refresh({ tokenUrl: target.tokenUrl, refreshToken: 'rt', client: { id: 'client-1', secret: 's3' } });
    expect(seen[1].body).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'client-1', client_secret: 's3' });
  });
});
