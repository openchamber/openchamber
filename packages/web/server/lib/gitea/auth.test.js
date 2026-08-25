import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitea-auth-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const {
  getGiteaAuth,
  getGiteaAuthAccounts,
  setGiteaAuth,
  activateGiteaAuth,
  clearGiteaAuth,
  normalizeBaseUrl,
  GITEA_AUTH_FILE,
} = await import('./auth.js');

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  if (fs.existsSync(GITEA_AUTH_FILE)) {
    fs.unlinkSync(GITEA_AUTH_FILE);
  }
});

const aliceUser = {
  id: 42,
  login: 'alice',
  full_name: 'Alice Example',
  avatar_url: 'https://gitea.example.com/avatars/alice.png',
  html_url: 'https://gitea.example.com/alice',
  email: 'alice@example.com',
};

describe('normalizeBaseUrl', () => {
  test('adds https scheme when missing', () => {
    expect(normalizeBaseUrl('gitea.example.com')).toBe('https://gitea.example.com');
  });

  test('strips trailing slash', () => {
    expect(normalizeBaseUrl('https://gitea.example.com/')).toBe('https://gitea.example.com');
    expect(normalizeBaseUrl('https://gitea.example.com/gitea/')).toBe('https://gitea.example.com/gitea');
  });

  test('keeps an explicit scheme', () => {
    expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  test('returns null for invalid input', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
    expect(normalizeBaseUrl('://bad')).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
  });
});

describe('setGiteaAuth', () => {
  test('stores an account with a host-prefixed accountId', () => {
    setGiteaAuth({ accessToken: 'gitea-secret', baseUrl: 'gitea.example.com', user: aliceUser });

    const auth = getGiteaAuth();
    expect(auth).not.toBeNull();
    expect(auth.accountId).toBe('gitea.example.com:alice');
    expect(auth.baseUrl).toBe('https://gitea.example.com');
    expect(auth.username).toBe('alice');
    expect(auth.name).toBe('Alice Example');
    expect(auth.avatarUrl).toBe('https://gitea.example.com/avatars/alice.png');
    expect(auth.webUrl).toBe('https://gitea.example.com/alice');
    expect(auth.email).toBe('alice@example.com');
    expect(auth.current).toBe(true);
    expect(auth.createdAt).toEqual(expect.any(Number));
  });

  test('writes the auth file with 0600 permissions', () => {
    setGiteaAuth({ accessToken: 'gitea-secret', baseUrl: 'https://gitea.example.com', user: aliceUser });
    const stats = fs.statSync(GITEA_AUTH_FILE);
    // 0o600 mask
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test('replaces the same account instead of duplicating it', () => {
    setGiteaAuth({ accessToken: 'gitea-old', baseUrl: 'gitea.example.com', user: aliceUser });
    setGiteaAuth({
      accessToken: 'gitea-new',
      baseUrl: 'https://gitea.example.com',
      user: { ...aliceUser, full_name: 'Alice Renamed' },
    });

    const accounts = getGiteaAuthAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].user.name).toBe('Alice Renamed');
    expect(getGiteaAuth().accessToken).toBe('gitea-new');
  });

  test('falls back to a token prefix accountId when username is missing', () => {
    setGiteaAuth({ accessToken: 'gitea-prefixtest', baseUrl: 'gitea.example.com', user: { id: 1 } });
    const accounts = getGiteaAuthAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('token:gitea-pr');
  });

  test('requires an access token', () => {
    expect(() => setGiteaAuth({ baseUrl: 'gitea.example.com', user: aliceUser })).toThrow('accessToken is required');
  });

  test('requires a base URL (no default instance)', () => {
    expect(() => setGiteaAuth({ accessToken: 'gitea-secret', user: aliceUser })).toThrow('baseUrl is required and must be a valid URL');
    expect(() => setGiteaAuth({ accessToken: 'gitea-secret', baseUrl: 'not a url', user: aliceUser })).toThrow('baseUrl is required and must be a valid URL');
  });
});

describe('multi-account switching', () => {
  test('tracks a single current account and can switch it', () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    setGiteaAuth({
      accessToken: 'gitea-b',
      baseUrl: 'https://gitea.other.example',
      user: { ...aliceUser, login: 'bob', full_name: 'Bob' },
    });

    expect(getGiteaAuth().accountId).toBe('gitea.other.example:bob');

    const switched = activateGiteaAuth('gitea.example.com:alice');
    expect(switched).toBe(true);
    expect(getGiteaAuth().accountId).toBe('gitea.example.com:alice');
    expect(getGiteaAuthAccounts().find((a) => a.id === 'gitea.other.example:bob')?.current).toBe(false);
  });

  test('activate returns false for an unknown account', () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    expect(activateGiteaAuth('gitea.example.com:nobody')).toBe(false);
    expect(activateGiteaAuth('')).toBe(false);
    expect(activateGiteaAuth(undefined)).toBe(false);
  });
});

describe('clearGiteaAuth', () => {
  test('removes the current account and deletes the file when empty', () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    const removed = clearGiteaAuth();
    expect(removed).toBe(true);
    expect(getGiteaAuth()).toBeNull();
    expect(fs.existsSync(GITEA_AUTH_FILE)).toBe(false);
  });

  test('keeps other accounts and promotes the first remaining', () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    setGiteaAuth({
      accessToken: 'gitea-b',
      baseUrl: 'https://gitea.other.example',
      user: { ...aliceUser, login: 'bob' },
    });
    clearGiteaAuth();

    const accounts = getGiteaAuthAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('gitea.example.com:alice');
    expect(accounts[0].current).toBe(true);
  });
});

describe('no default base URL', () => {
  test('the module exports no DEFAULT_GITEA_BASE_URL', async () => {
    const module = await import('./auth.js');
    expect(module.DEFAULT_GITEA_BASE_URL).toBeUndefined();
  });

  test('accounts always carry a real baseUrl', () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    for (const account of getGiteaAuthAccounts()) {
      expect(account.baseUrl).toMatch(/^https?:\/\//);
    }
  });
});
