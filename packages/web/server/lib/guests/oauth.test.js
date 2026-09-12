import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getGuestAuth, guestAuthPersistPath, patchGuestAuth } from './auth-store.js';
import {
  clearGuestPendingForTests,
  consumeGuestAuthorization,
  createPkcePair,
  encodeBasicCredential,
  guestAuthorizationHeader,
  guestRedirectUri,
  saveGuestAccessToken,
  startGuestAuthorization,
  toPublicGuestAuth,
} from './oauth.js';

const clickupGuest = {
  id: 'clickup',
  integration: {
    name: 'ClickUp',
    description: 'Tasks',
    oauth: {
      authorizeUrl: 'https://app.clickup.com/api',
      tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
      apiOrigin: 'https://api.clickup.com',
      account: { path: '/api/v2/user', name: 'user.username' },
    },
  },
};

afterEach(() => {
  clearGuestPendingForTests();
});

describe('guestRedirectUri', () => {
  test('stays on the server origin', () => {
    expect(guestRedirectUri('http://127.0.0.1:4096', 'clickup'))
      .toBe('http://127.0.0.1:4096/api/guests/clickup/oauth/callback');
  });
});

describe('toPublicGuestAuth', () => {
  test('never forwards tokens', () => {
    expect(toPublicGuestAuth({
      clientId: 'id',
      clientSecret: 'secret',
      accessToken: 'tok',
      account: 'ada',
      settings: { 'list-id': '1' },
    })).toEqual({
      connected: true,
      account: 'ada',
      hasClient: true,
      settings: { 'list-id': '1' },
    });
  });
});

describe('startGuestAuthorization', () => {
  test('builds a PKCE authorize URL after a client id is saved', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-oauth-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { clientId: 'app-id', clientSecret: 'app-secret' }, persistPath);
    const started = await startGuestAuthorization({
      guest: clickupGuest,
      persistPath,
      origin: 'http://127.0.0.1:4096',
    });
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://app.clickup.com/api');
    expect(url.searchParams.get('client_id')).toBe('app-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4096/api/guests/clickup/oauth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('refuses start without a client id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-oauth-'));
    const persistPath = guestAuthPersistPath(dir);
    try {
      await startGuestAuthorization({
        guest: clickupGuest,
        persistPath,
        origin: 'http://127.0.0.1:4096',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.code).toBe('CLIENT_MISSING');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('consumeGuestAuthorization', () => {
  test('stores tokens from the token endpoint and never returns them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-oauth-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { clientId: 'app-id', clientSecret: 'app-secret' }, persistPath);
    const started = await startGuestAuthorization({
      guest: clickupGuest,
      persistPath,
      origin: 'http://127.0.0.1:4096',
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.clickup.com/api/v2/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (target === 'https://api.clickup.com/api/v2/user') {
        return new Response(JSON.stringify({ user: { username: 'ada' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    };
    try {
      const result = await consumeGuestAuthorization({
        guest: clickupGuest,
        persistPath,
        code: 'auth-code',
        state,
      });
      expect(result).toEqual({ connected: true, account: 'ada' });
      const stored = await getGuestAuth('clickup', persistPath);
      expect(stored.accessToken).toBe('access-1');
      expect(toPublicGuestAuth(stored).accessToken).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a callback without state even when this guest has one pending exchange', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-oauth-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { clientId: 'app-id', clientSecret: 'app-secret' }, persistPath);
    await startGuestAuthorization({
      guest: clickupGuest,
      persistPath,
      origin: 'http://127.0.0.1:4096',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.clickup.com/api/v2/oauth/token') {
        return new Response(JSON.stringify({ access_token: 'access-2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://api.clickup.com/api/v2/user') {
        return new Response(JSON.stringify({ user: { username: 'ada' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    };
    try {
      await expect(consumeGuestAuthorization({
        guest: clickupGuest,
        persistPath,
        code: 'auth-code',
        state: '',
      })).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('falls back to a JSON token body when form exchange fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-oauth-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { clientId: 'app-id', clientSecret: 'app-secret' }, persistPath);
    const started = await startGuestAuthorization({
      guest: clickupGuest,
      persistPath,
      origin: 'http://127.0.0.1:4096',
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const originalFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target === 'https://api.clickup.com/api/v2/oauth/token') {
        seen.push(init.headers['Content-Type']);
        if (init.headers['Content-Type'] === 'application/x-www-form-urlencoded') {
          return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
        }
        const body = JSON.parse(init.body);
        expect(body).toEqual({
          client_id: 'app-id',
          client_secret: 'app-secret',
          code: 'auth-code',
        });
        return new Response(JSON.stringify({ access_token: 'access-json' }), { status: 200 });
      }
      if (target === 'https://api.clickup.com/api/v2/user') {
        return new Response(JSON.stringify({ user: { username: 'ada' } }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${target}`);
    };
    try {
      const result = await consumeGuestAuthorization({
        guest: clickupGuest,
        persistPath,
        code: 'auth-code',
        state,
      });
      expect(result).toEqual({ connected: true, account: 'ada' });
      expect(seen).toEqual([
        'application/x-www-form-urlencoded',
        'application/json',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects an unknown state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-oauth-'));
    const persistPath = guestAuthPersistPath(dir);
    try {
      await consumeGuestAuthorization({
        guest: clickupGuest,
        persistPath,
        code: 'auth-code',
        state: 'nope',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.code).toBe('STATE_MISMATCH');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('createPkcePair', () => {
  test('returns a verifier and challenge', () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThan(20);
    expect(pair.challenge.length).toBeGreaterThan(20);
    expect(pair.verifier).not.toBe(pair.challenge);
  });
});

describe('saveGuestAccessToken with a basic scheme', () => {
  const jiraGuest = {
    id: 'jira',
    integration: {
      name: 'Jira',
      description: 'Issues',
      token: {
        apiOrigin: 'https://acme.atlassian.net',
        scheme: 'basic',
        account: { path: '/rest/api/3/myself', name: 'displayName' },
      },
    },
  };

  test('encodes username:token, probes with a Basic header, and stores only the pair', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-basic-'));
    const persistPath = guestAuthPersistPath(dir);
    const originalFetch = globalThis.fetch;
    let seenAuthorization = '';
    globalThis.fetch = async (url, init) => {
      expect(String(url)).toBe('https://acme.atlassian.net/rest/api/3/myself');
      seenAuthorization = init.headers.Authorization;
      return new Response(JSON.stringify({ displayName: 'Ada Lovelace' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await saveGuestAccessToken({ guest: jiraGuest, persistPath, token: 'api-token', username: 'ada@acme.example' });
      expect(result).toEqual({ connected: true, account: 'Ada Lovelace' });
      const expected = encodeBasicCredential('ada@acme.example', 'api-token');
      expect(seenAuthorization).toBe(`Basic ${expected}`);
      const stored = await getGuestAuth('jira', persistPath);
      expect(stored.accessToken).toBe(expected);
      expect(stored.tokenType).toBe('basic');
      expect(guestAuthorizationHeader(stored.accessToken, 'basic')).toBe(`Basic ${expected}`);
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses a basic integration without a username', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-basic-'));
    const persistPath = guestAuthPersistPath(dir);
    try {
      await expect(saveGuestAccessToken({ guest: jiraGuest, persistPath, token: 'api-token' }))
        .rejects.toMatchObject({ code: 'USERNAME_MISSING' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('uses the username as the account label when the manifest declares no account probe', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-basic-'));
    const persistPath = guestAuthPersistPath(dir);
    const guest = { ...jiraGuest, integration: { ...jiraGuest.integration, token: { apiOrigin: 'https://acme.atlassian.net', scheme: 'basic' } } };
    try {
      const result = await saveGuestAccessToken({ guest, persistPath, token: 'api-token', username: 'ada@acme.example' });
      expect(result).toEqual({ connected: true, account: 'ada@acme.example' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
