import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitlab-auth-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const {
  getGitLabAuth,
  getGitLabAuthAccounts,
  setGitLabAuth,
  activateGitLabAuth,
  clearGitLabAuth,
  normalizeBaseUrl,
  GITLAB_AUTH_FILE,
  DEFAULT_GITLAB_BASE_URL,
} = await import('./auth.js');

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  if (fs.existsSync(GITLAB_AUTH_FILE)) {
    fs.unlinkSync(GITLAB_AUTH_FILE);
  }
});

const aliceUser = {
  id: 42,
  username: 'alice',
  name: 'Alice Example',
  state: 'active',
  avatar_url: 'https://gitlab.com/uploads/-/avatar.png',
  web_url: 'https://gitlab.com/alice',
  email: 'alice@example.com',
};

describe('normalizeBaseUrl', () => {
  test('adds https scheme when missing', () => {
    expect(normalizeBaseUrl('gitlab.example.com')).toBe('https://gitlab.example.com');
  });

  test('strips trailing slash', () => {
    expect(normalizeBaseUrl('https://gitlab.com/')).toBe('https://gitlab.com');
    expect(normalizeBaseUrl('https://gitlab.example.com/gitlab/')).toBe('https://gitlab.example.com/gitlab');
  });

  test('keeps an explicit scheme', () => {
    expect(normalizeBaseUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  test('returns null for invalid input', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
    expect(normalizeBaseUrl('://bad')).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
  });
});

describe('setGitLabAuth', () => {
  test('stores an account with a host-prefixed accountId', () => {
    setGitLabAuth({ accessToken: 'glpat-secret', baseUrl: 'gitlab.com', user: aliceUser });

    const auth = getGitLabAuth();
    expect(auth).not.toBeNull();
    expect(auth.accountId).toBe('gitlab.com:alice');
    expect(auth.baseUrl).toBe('https://gitlab.com');
    expect(auth.username).toBe('alice');
    expect(auth.name).toBe('Alice Example');
    expect(auth.avatarUrl).toBe('https://gitlab.com/uploads/-/avatar.png');
    expect(auth.webUrl).toBe('https://gitlab.com/alice');
    expect(auth.email).toBe('alice@example.com');
    expect(auth.current).toBe(true);
    expect(auth.createdAt).toEqual(expect.any(Number));
  });

  test('writes the auth file with 0600 permissions', () => {
    setGitLabAuth({ accessToken: 'glpat-secret', baseUrl: DEFAULT_GITLAB_BASE_URL, user: aliceUser });
    const stats = fs.statSync(GITLAB_AUTH_FILE);
    // 0o600 mask
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test('replaces the same account instead of duplicating it', () => {
    setGitLabAuth({ accessToken: 'glpat-old', baseUrl: 'gitlab.com', user: aliceUser });
    setGitLabAuth({
      accessToken: 'glpat-new',
      baseUrl: 'https://gitlab.com',
      user: { ...aliceUser, name: 'Alice Renamed' },
    });

    const accounts = getGitLabAuthAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].user.name).toBe('Alice Renamed');
    expect(getGitLabAuth().accessToken).toBe('glpat-new');
  });

  test('falls back to a token prefix accountId when username is missing', () => {
    setGitLabAuth({ accessToken: 'glpat-prefixtest', baseUrl: 'gitlab.com', user: { id: 1 } });
    const accounts = getGitLabAuthAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('token:glpat-pr');
  });

  test('requires an access token', () => {
    expect(() => setGitLabAuth({ baseUrl: 'gitlab.com', user: aliceUser })).toThrow('accessToken is required');
  });
});

describe('multi-account switching', () => {
  test('tracks a single current account and can switch it', () => {
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    setGitLabAuth({
      accessToken: 'glpat-b',
      baseUrl: 'https://gitlab.example.com',
      user: { ...aliceUser, username: 'bob', name: 'Bob' },
    });

    expect(getGitLabAuth().accountId).toBe('gitlab.example.com:bob');

    const switched = activateGitLabAuth('gitlab.com:alice');
    expect(switched).toBe(true);
    expect(getGitLabAuth().accountId).toBe('gitlab.com:alice');
    expect(getGitLabAuthAccounts().find((a) => a.id === 'gitlab.example.com:bob')?.current).toBe(false);
  });

  test('activate returns false for an unknown account', () => {
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    expect(activateGitLabAuth('gitlab.com:nobody')).toBe(false);
    expect(activateGitLabAuth('')).toBe(false);
    expect(activateGitLabAuth(undefined)).toBe(false);
  });
});

describe('clearGitLabAuth', () => {
  test('removes the current account and deletes the file when empty', () => {
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    const removed = clearGitLabAuth();
    expect(removed).toBe(true);
    expect(getGitLabAuth()).toBeNull();
    expect(fs.existsSync(GITLAB_AUTH_FILE)).toBe(false);
  });

  test('keeps other accounts and promotes the first remaining', () => {
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    setGitLabAuth({
      accessToken: 'glpat-b',
      baseUrl: 'https://gitlab.example.com',
      user: { ...aliceUser, username: 'bob' },
    });
    clearGitLabAuth();

    const accounts = getGitLabAuthAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('gitlab.com:alice');
    expect(accounts[0].current).toBe(true);
  });
});
