import { afterEach, describe, expect, it } from 'bun:test';
import {
  CLAUDE_CLI_TOKEN_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_SESSION_EXPIRED_ERROR,
  CLAUDE_USAGE_URL,
  OPENCODE_CLAUDE_TOKEN_URL,
  __resetClaudeRefreshLockForTests,
  ensureClaudeUsageAccessToken,
  isClaudeAccessExpired,
  refreshClaudeOAuthToken,
  resolveClaudeUsageCredential,
} from './claude-oauth.js';
import { extractClaudeOAuthCredentials, writeClaudeCliOAuthCredentials } from './claude-cli-auth.js';
import { mapClaudeUsageWindows, providerName } from './claude.js';

describe('claude quota provider', () => {
  afterEach(() => {
    __resetClaudeRefreshLockForTests();
  });

  it('labels the provider as Claude subscription usage', () => {
    expect(providerName).toBe('Claude subscription');
  });

  it('maps Anthropic oauth usage windows without inventing data', () => {
    const windows = mapClaudeUsageWindows({
      five_hour: { utilization: 12.5, resets_at: '2026-07-25T12:00:00Z' },
      seven_day: { utilization: 40, resets_at: '2026-08-01T00:00:00Z' },
    });

    expect(windows['5h']?.usedPercent).toBe(12.5);
    expect(windows['7d']?.usedPercent).toBe(40);
    expect(windows['7d-sonnet']).toBeUndefined();
  });

  it('returns an empty window map for empty payloads', () => {
    expect(mapClaudeUsageWindows(null)).toEqual({});
    expect(mapClaudeUsageWindows({})).toEqual({});
  });

  it('treats access tokens as expired inside the refresh buffer', () => {
    const now = 1_000_000;
    expect(isClaudeAccessExpired(now + 30_000, now)).toBe(true);
    expect(isClaudeAccessExpired(now + 120_000, now)).toBe(false);
    expect(isClaudeAccessExpired(null, now)).toBe(false);
  });

  it('extracts refresh + expiry from Claude CLI credentials', () => {
    expect(extractClaudeOAuthCredentials({
      claudeAiOauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1_700_000_000_000,
      },
    })).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1_700_000_000_000,
    });
  });

  it('resolves OpenCode auth credentials for refresh', () => {
    const resolved = resolveClaudeUsageCredential({
      env: {},
      homeDir: '/missing-home',
      existsSync: () => false,
      readFile: () => '',
      readAuth: () => ({
        anthropic: {
          type: 'oauth',
          access: 'stale-access',
          refresh: 'refresh-token',
          expires: Date.now() - 60_000,
        },
      }),
    });

    expect(resolved).toMatchObject({
      accessToken: 'stale-access',
      refreshToken: 'refresh-token',
      source: 'opencode-auth',
      tokenUrl: OPENCODE_CLAUDE_TOKEN_URL,
      authKey: 'anthropic',
    });
  });

  it('refreshes via the OpenCode Anthropic OAuth contract', async () => {
    const calls = [];
    const result = await refreshClaudeOAuthToken({
      refreshToken: 'refresh-token',
      tokenUrl: OPENCODE_CLAUDE_TOKEN_URL,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body || '{}')) });
        return new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }), { status: 200 });
      },
    });

    expect(calls[0]?.url).toBe(OPENCODE_CLAUDE_TOKEN_URL);
    expect(calls[0]?.body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('rotated-refresh');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refreshes expired OpenCode tokens and persists the rotation', async () => {
    const auth = {
      anthropic: {
        type: 'oauth',
        access: 'expired-access',
        refresh: 'refresh-token',
        expires: Date.now() - 60_000,
      },
    };
    let wrote = null;

    const access = await ensureClaudeUsageAccessToken({
      env: {},
      homeDir: '/missing-home',
      existsSync: () => false,
      readFile: () => '',
      readAuth: () => auth,
      writeAuth: (next) => {
        wrote = next;
        Object.assign(auth, next);
      },
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 7200,
      }), { status: 200 }),
    });

    expect(access).toMatchObject({
      accessToken: 'fresh-access',
      source: 'opencode-auth',
      canRefresh: true,
    });
    expect(wrote?.anthropic).toMatchObject({
      type: 'oauth',
      access: 'fresh-access',
      refresh: 'fresh-refresh',
    });
    expect(typeof wrote?.anthropic?.expires).toBe('number');
    expect(wrote.anthropic.expires).toBeGreaterThan(Date.now());
  });

  it('single-flights concurrent Claude refreshes', async () => {
    let refreshCalls = 0;
    const auth = {
      anthropic: {
        type: 'oauth',
        access: 'expired-access',
        refresh: 'refresh-token',
        expires: Date.now() - 60_000,
      },
    };

    const options = {
      env: {},
      homeDir: '/missing-home',
      existsSync: () => false,
      readFile: () => '',
      readAuth: () => auth,
      writeAuth: (next) => Object.assign(auth, next),
      fetchImpl: async () => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({
          access_token: 'shared-access',
          refresh_token: 'shared-refresh',
          expires_in: 3600,
        }), { status: 200 });
      },
    };

    const [first, second] = await Promise.all([
      ensureClaudeUsageAccessToken(options),
      ensureClaudeUsageAccessToken(options),
    ]);

    expect(refreshCalls).toBe(1);
    expect(first?.accessToken).toBe('shared-access');
    expect(second?.accessToken).toBe('shared-access');
  });

  it('writes refreshed Claude CLI credentials without dropping other fields', () => {
    const files = new Map([
      ['/tmp/creds.json', JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old',
          refreshToken: 'old-refresh',
          expiresAt: 1,
          scopes: ['user:inference'],
        },
        other: true,
      })],
    ]);

    writeClaudeCliOAuthCredentials('/tmp/creds.json', {
      accessToken: 'new',
      refreshToken: 'new-refresh',
      expiresAt: 99,
    }, {
      existsSync: (filePath) => files.has(filePath) || filePath.endsWith('.tmp'),
      readFile: (filePath) => files.get(filePath) || '',
      writeFile: (filePath, data) => {
        files.set(filePath, String(data));
      },
      renameSync: (from, to) => {
        files.set(to, files.get(from) || '');
        files.delete(from);
      },
      chmodSync: () => {},
    });

    const written = JSON.parse(files.get('/tmp/creds.json'));
    expect(written.other).toBe(true);
    expect(written.claudeAiOauth).toEqual({
      accessToken: 'new',
      refreshToken: 'new-refresh',
      expiresAt: 99,
      scopes: ['user:inference'],
    });
  });

  it('uses the Claude CLI token URL for CLI credential sources', () => {
    const resolved = resolveClaudeUsageCredential({
      env: {},
      homeDir: '/home/u',
      existsSync: (filePath) => filePath.endsWith('.claude/.credentials.json'),
      readFile: () => JSON.stringify({
        claudeAiOauth: {
          accessToken: 'cli-access',
          refreshToken: 'cli-refresh',
          expiresAt: Date.now() + 120_000,
        },
      }),
      readAuth: () => ({}),
    });

    expect(resolved).toMatchObject({
      source: 'claude-cli',
      tokenUrl: CLAUDE_CLI_TOKEN_URL,
      refreshToken: 'cli-refresh',
    });
  });

  it('exposes a stable session-expired message constant for UI panels', () => {
    expect(CLAUDE_USAGE_URL).toContain('/api/oauth/usage');
    expect(CLAUDE_SESSION_EXPIRED_ERROR).toContain('re-authenticate');
  });
});
