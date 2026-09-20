import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getGuestAuth, guestAuthPersistPath, patchGuestAuth } from './auth-store.js';
import { credentialTarget } from './oauth.js';
import { joinGuestRequestUrl, proxyGuestRequest } from './request.js';

const clickupGuest = {
  id: 'clickup',
  integration: {
    name: 'ClickUp',
    description: 'Tasks',
    oauth: {
      authorizeUrl: 'https://app.clickup.com/api',
      tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
      apiOrigin: 'https://api.clickup.com',
    },
  },
};

describe('joinGuestRequestUrl', () => {
  test('stays on the declared origin and rejects escapes', () => {
    expect(joinGuestRequestUrl('https://api.clickup.com', '/api/v2/user')?.href)
      .toBe('https://api.clickup.com/api/v2/user');
    expect(joinGuestRequestUrl('https://api.clickup.com', '/api/../secret')).toBeNull();
    expect(joinGuestRequestUrl('https://api.clickup.com', 'https://evil.example/x')).toBeNull();
    expect(joinGuestRequestUrl('https://api.clickup.com', '//evil.example/x')).toBeNull();
  });
});

describe('proxyGuestRequest', () => {
  test('attaches the stored bearer and returns the capped body', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-req-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { accessToken: 'tok-1', target: credentialTarget(clickupGuest.integration) }, persistPath);
    const originalFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ href: String(url), auth: init.headers.Authorization });
      return new Response('{"ok":true}', { status: 200 });
    };
    try {
      const result = await proxyGuestRequest({
        guest: clickupGuest,
        persistPath,
        method: 'GET',
        path: '/api/v2/list/1/task',
      });
      expect(result).toEqual({ status: 200, body: '{"ok":true}' });
      expect(seen).toEqual([{
        href: 'https://api.clickup.com/api/v2/list/1/task',
        auth: 'Bearer tok-1',
      }]);
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('sends a pasted token as the Authorization header', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-req-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { accessToken: 'pk_tok', target: { apiOrigin: 'https://api.clickup.com' } }, persistPath);
    const originalFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ href: String(url), auth: init.headers.Authorization });
      return new Response('{"ok":true}', { status: 200 });
    };
    try {
      const result = await proxyGuestRequest({
        guest: {
          id: 'clickup',
          integration: {
            name: 'ClickUp',
            description: 'Tasks',
            token: { apiOrigin: 'https://api.clickup.com' },
          },
        },
        persistPath,
        method: 'GET',
        path: '/api/v2/user',
      });
      expect(result).toEqual({ status: 200, body: '{"ok":true}' });
      expect(seen).toEqual([{
        href: 'https://api.clickup.com/api/v2/user',
        auth: 'pk_tok',
      }]);
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('drops tokens when a 401 cannot refresh', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-req-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { accessToken: 'tok-old', target: credentialTarget(clickupGuest.integration) }, persistPath);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 401 });
    try {
      await proxyGuestRequest({
        guest: clickupGuest,
        persistPath,
        method: 'GET',
        path: '/api/v2/user',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.code).toBe('DISCONNECTED');
    }
    expect((await getGuestAuth('clickup', persistPath))?.accessToken).toBeUndefined();
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('refuses a disconnected guest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-req-'));
    const persistPath = guestAuthPersistPath(dir);
    try {
      await proxyGuestRequest({
        guest: clickupGuest,
        persistPath,
        method: 'GET',
        path: '/api/v2/user',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.code).toBe('DISCONNECTED');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('credential target', () => {
  test('drops a token minted for another API origin instead of sending it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-req-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { accessToken: 'tok-1', target: { apiOrigin: 'https://api.old.example' } }, persistPath);
    const originalFetch = globalThis.fetch;
    let requested = 0;
    globalThis.fetch = async () => {
      requested += 1;
      return new Response('{"ok":true}', { status: 200 });
    };
    try {
      await expect(proxyGuestRequest({ guest: clickupGuest, persistPath, method: 'GET', path: '/api/v2/user' }))
        .rejects.toMatchObject({ code: 'DISCONNECTED' });
      expect(requested).toBe(0);
      expect((await getGuestAuth('clickup', persistPath))?.accessToken).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a token without a recorded target never counts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-req-'));
    const persistPath = guestAuthPersistPath(dir);
    await patchGuestAuth('clickup', { accessToken: 'tok-1' }, persistPath);
    try {
      await expect(proxyGuestRequest({ guest: clickupGuest, persistPath, method: 'GET', path: '/api/v2/user' }))
        .rejects.toMatchObject({ code: 'DISCONNECTED' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a 401 while the user reconnects', () => {
  test('drops only the tokens the request was refused with, not the new connection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-req-'));
    const persistPath = guestAuthPersistPath(dir);
    const target = credentialTarget(clickupGuest.integration);
    await patchGuestAuth('clickup', {
      clientId: 'app-id', clientSecret: 'app-secret', clientTarget: target,
      accessToken: 'access-a', refreshToken: 'refresh-a', target,
    }, persistPath);
    const originalFetch = globalThis.fetch;
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    globalThis.fetch = async (url) => {
      if (String(url) === 'https://api.clickup.com/api/v2/oauth/token') {
        await refreshGate;
        return new Response(JSON.stringify({ access_token: 'access-a2', refresh_token: 'refresh-a2', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('nope', { status: 401 });
    };
    try {
      const request = proxyGuestRequest({ guest: clickupGuest, persistPath, method: 'GET', path: '/api/v2/user' });
      // The user connects again while the refresh is in flight.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await patchGuestAuth('clickup', { accessToken: 'access-b', refreshToken: 'refresh-b', target }, persistPath);
      releaseRefresh();
      await expect(request).rejects.toMatchObject({ code: 'DISCONNECTED' });
      const stored = await getGuestAuth('clickup', persistPath);
      expect(stored.accessToken).toBe('access-b');
      expect(stored.refreshToken).toBe('refresh-b');
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
