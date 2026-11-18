import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_ACCOUNTS_PATHS } from '../../utils/index.js';
import { fetchQuota } from './index.js';

const originalPaths = [...ANTIGRAVITY_ACCOUNTS_PATHS];
let directory;
let accountPath;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'antigravity-provider-'));
  accountPath = join(directory, 'accounts.json');
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, accountPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, ...originalPaths);
  rmSync(directory, { recursive: true, force: true });
});

const account = (refreshToken = 'test-refresh') => {
  writeFileSync(accountPath, JSON.stringify({ accounts: [{ refreshToken }] }));
};

describe('Antigravity provider composition', () => {
  it('reports an unconfigured account without making requests', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await fetchQuota()).toMatchObject({
      providerId: 'antigravity', ok: false, configured: false,
      error: 'Not configured', usage: null
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the null refresh token forwarded to OAuth', async () => {
    account(42);
    const fetch = vi.fn(async (_url, options) => {
      expect(new URLSearchParams(options.body).get('refresh_token')).toBe('null');
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await fetchQuota()).toMatchObject({
      ok: false, configured: true,
      error: 'Failed to refresh Antigravity token', usage: null
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports empty model results after a successful refresh', async () => {
    account();
    vi.stubGlobal('fetch', async (url) => Response.json(
      url === 'https://oauth2.googleapis.com/token' ? { access_token: 'test-access' } : {}
    ));
    expect(await fetchQuota()).toMatchObject({
      ok: false, configured: true,
      error: 'Failed to fetch Antigravity quota', usage: null
    });
  });

  it('returns model windows using the default project', async () => {
    account();
    vi.stubGlobal('fetch', async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'test-access' });
      }
      expect(JSON.parse(options.body)).toEqual({ project: 'rising-fact-p41fc' });
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-access');
      return Response.json(url.endsWith(':retrieveUserQuotaSummary') ? {} : {
        models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.75 } } }
      });
    });
    expect(await fetchQuota()).toMatchObject({
      ok: true, configured: true,
      usage: { windows: {}, models: { 'gemini-test': { windows: {
        '5h': { usedPercent: 25, remainingPercent: 75 }
      } } } }
    });
  });
});
