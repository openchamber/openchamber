import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../credentials/store.js';
import * as fetchUtils from '../utils/fetch.js';
import * as mistral from './mistral.js';

/**
 * Sanitized tRPC batch response fixture for the canonical Mistral console
 * endpoint `user.me,vibe.getApiKey,billing.vibeUsage?batch=1`. The canonical
 * parser extracts `usage_percentage`, `reset_at`, and `email` via regex from
 * the raw response text, so the fixture is a JSON array of batch results
 * shaped like the real tRPC envelope: `[{ result: { data: { json } } }, ...]`.
 *
 * Order matches the batch: [user.me, vibe.getApiKey, billing.vibeUsage].
 * `billing.vibeUsage` carries `usage_percentage` and `reset_at`; `user.me`
 * carries `email` and the plan name.
 */
function makeTrpcBatchFixture({ email, planName, usagePercentage, resetAt }) {
  return JSON.stringify([
    {
      result: {
        data: {
          json: {
            email,
            plan: { name: planName, tier: 'vibe' },
          },
        },
      },
    },
    {
      result: {
        data: {
          json: {
            apiKey: 'redacted',
          },
        },
      },
    },
    {
      result: {
        data: {
          json: {
            usage_percentage: usagePercentage,
            reset_at: resetAt,
          },
        },
      },
    },
  ]);
}

describe('mistral quota provider', () => {
  let loadCredentialsSpy;
  let fetchWithRetrySpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    loadCredentialsSpy = vi.spyOn(store, 'loadCredentials');
    fetchWithRetrySpy = vi.spyOn(fetchUtils, 'fetchWithRetry');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when no credentials', () => {
    loadCredentialsSpy.mockReturnValue([]);
    expect(mistral.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when single cookie contains csrftoken=', () => {
    loadCredentialsSpy.mockReturnValue([{
      providerId: 'mistral',
      credential: { cookie: 'csrftoken=abc; session=xyz' },
    }]);
    expect(mistral.isConfigured()).toBe(true);
  });

  it('isConfigured returns true when cookie contains current csrf_token_<id>= name', () => {
    loadCredentialsSpy.mockReturnValue([{
      providerId: 'mistral',
      credential: { cookie: 'csrf_token_abc123=abc; ory_session_xyz=session' },
    }]);
    expect(mistral.isConfigured()).toBe(true);
  });

  it('isConfigured returns true when accounts[] array present', () => {
    loadCredentialsSpy.mockReturnValue([{
      providerId: 'mistral',
      credential: {
        accounts: [{ cookie: 'csrftoken=abc; session=xyz' }],
      },
    }]);
    expect(mistral.isConfigured()).toBe(true);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    loadCredentialsSpy.mockReturnValue([]);
    const result = await mistral.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('fetchQuota returns configured:false when cookie lacks csrftoken=', async () => {
    loadCredentialsSpy.mockReturnValue([{
      providerId: 'mistral',
      credential: { cookie: 'session=xyz' },
    }]);
    const result = await mistral.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/csrf_token/);
  });

  it('returns an actionable error when stored cookie cannot be sent as an HTTP header', async () => {
    loadCredentialsSpy.mockReturnValue([{
      providerId: 'mistral',
      credential: { cookie: 'csrftoken=abc…; ory_session=xyz' },
      accountHint: null,
    }]);

    const result = await mistral.fetchQuota();

    expect(fetchWithRetrySpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('invalid characters');
  });

  it('queries each configured account and populates usage.accounts[]', async () => {
    const accounts = [
      {
        alias: 'primary',
        cookie: 'csrftoken=token-a; session=sess-a',
      },
      {
        cookie: 'csrf_token_hash=token-b; session=sess-b',
      },
    ];
    loadCredentialsSpy.mockReturnValue([{
      id: 'cred-primary',
      providerId: 'mistral',
      credential: { accounts },
      accountHint: null,
    }]);

    const fixtureA = makeTrpcBatchFixture({
      email: 'alice@example.com',
      planName: 'Vibe',
      usagePercentage: 25,
      resetAt: '2026-07-01T00:00:00.000Z',
    });
    const fixtureB = makeTrpcBatchFixture({
      email: 'bob@example.com',
      planName: 'Vibe',
      usagePercentage: 80,
      resetAt: '2026-07-02T00:00:00.000Z',
    });

    fetchWithRetrySpy.mockImplementation(async (url, options) => {
      const cookie = options?.headers?.Cookie ?? '';
      if (cookie.includes('token-a')) {
        expect(options?.timeout).toBe(10000);
        expect(options?.maxRetries).toBe(0);
        return { ok: true, status: 200, text: async () => fixtureA };
      }
      if (cookie.includes('token-b')) {
        expect(options?.headers?.['x-csrftoken']).toBe('token-b');
        return { ok: true, status: 200, text: async () => fixtureB };
      }
      return { ok: true, status: 200, text: async () => fixtureA };
    });

    const result = await mistral.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.error).toBeUndefined();

    // Two fetches — one per account.
    expect(fetchWithRetrySpy).toHaveBeenCalledTimes(2);

    // Top-level usage carries the FIRST account's data.
    expect(result.usage).toBeTruthy();
    expect(result.usage.windows).toBeTruthy();
    const topLevelKeys = Object.keys(result.usage.windows);
    expect(topLevelKeys.length).toBeGreaterThan(0);
    const topWindow = result.usage.windows[topLevelKeys[0]];
    expect(topWindow.usedPercent).toBe(25);
    expect(topWindow.remainingPercent).toBe(75);

    // Every account (including the first) is present in usage.accounts[].
    expect(Array.isArray(result.usage.accounts)).toBe(true);
    expect(result.usage.accounts).toHaveLength(2);

    const [acct0, acct1] = result.usage.accounts;
    expect(acct0.subtitle).toBe('alice@example.com');
    expect(acct0.windows).toBeTruthy();
    const acct0Keys = Object.keys(acct0.windows);
    expect(acct0Keys.length).toBeGreaterThan(0);
    expect(acct0.windows[acct0Keys[0]].usedPercent).toBe(25);

    expect(acct1.subtitle).toBe('bob@example.com');
    const acct1Keys = Object.keys(acct1.windows);
    expect(acct1Keys.length).toBeGreaterThan(0);
    expect(acct1.windows[acct1Keys[0]].usedPercent).toBe(80);
    expect(acct1.windows[acct1Keys[0]].remainingPercent).toBe(20);
  });

  it('queries every saved Mistral credential record', async () => {
    loadCredentialsSpy.mockReturnValue([
      {
        id: 'cred-primary',
        providerId: 'mistral',
        label: 'Primary subscription',
        credential: { cookie: 'csrf_token_a=token-a; ory_session_a=sess-a' },
      },
      {
        id: 'cred-secondary',
        providerId: 'mistral',
        label: 'Secondary subscription',
        credential: { cookie: 'csrf_token_b=token-b; ory_session_b=sess-b' },
      },
      {
        id: 'cred-other',
        providerId: 'byteplus',
        credential: { cookie: 'csrfToken=ignored' },
      },
    ]);

    const fixtureA = makeTrpcBatchFixture({
      email: 'primary@example.com',
      planName: 'Vibe',
      usagePercentage: 20,
      resetAt: '2026-07-01T00:00:00.000Z',
    });
    const fixtureB = makeTrpcBatchFixture({
      email: 'secondary@example.com',
      planName: 'Vibe',
      usagePercentage: 60,
      resetAt: '2026-07-02T00:00:00.000Z',
    });

    fetchWithRetrySpy.mockImplementation(async (_url, options) => {
      const cookie = options?.headers?.Cookie ?? '';
      if (cookie.includes('token-a')) return { ok: true, status: 200, text: async () => fixtureA };
      return { ok: true, status: 200, text: async () => fixtureB };
    });

    const result = await mistral.fetchQuota();

    expect(result.ok).toBe(true);
    expect(fetchWithRetrySpy).toHaveBeenCalledTimes(2);
    expect(result.usage.accounts).toHaveLength(2);
    expect(result.usage.accounts.map((account) => account.accountKey)).toEqual([
      'cred-primary',
      'cred-secondary',
    ]);
    expect(result.usage.accounts.map((account) => account.subtitle)).toEqual([
      'primary@example.com',
      'secondary@example.com',
    ]);
  });

  it('keeps a visible account entry when one saved credential fails', async () => {
    loadCredentialsSpy.mockReturnValue([
      {
        id: 'cred-primary',
        providerId: 'mistral',
        label: 'Primary subscription',
        credential: { cookie: 'csrf_token_a=token-a; ory_session_a=sess-a' },
      },
      {
        id: 'cred-secondary',
        providerId: 'mistral',
        label: 'Secondary subscription',
        credential: { cookie: 'csrf_token_b=token-b; ory_session_b=sess-b' },
      },
    ]);

    const fixtureA = makeTrpcBatchFixture({
      email: 'primary@example.com',
      planName: 'Vibe',
      usagePercentage: 20,
      resetAt: '2026-07-01T00:00:00.000Z',
    });

    fetchWithRetrySpy.mockImplementation(async (_url, options) => {
      const cookie = options?.headers?.Cookie ?? '';
      if (cookie.includes('token-a')) return { ok: true, status: 200, text: async () => fixtureA };
      return { ok: false, status: 401, text: async () => 'unauthorized' };
    });

    const result = await mistral.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.accounts).toHaveLength(2);
    expect(result.usage.accounts[0].subtitle).toBe('primary@example.com');
    expect(result.usage.accounts[1]).toMatchObject({
      accountKey: 'cred-secondary',
      label: 'Secondary subscription',
      subtitle: 'Failed to refresh usage data',
      note: 'API error: 401',
    });
  });

  it('falls back to stale cache on transient throw, no fallback on 401', async () => {
    loadCredentialsSpy.mockReturnValue([{
      id: 'cred-primary',
      providerId: 'mistral',
      credential: { cookie: 'csrftoken=token-a; session=sess-a' },
      accountHint: null,
    }]);

    // First call: succeed and seed the cache.
    const fixtureOk = makeTrpcBatchFixture({
      email: 'alice@example.com',
      planName: 'Vibe',
      usagePercentage: 10,
      resetAt: '2026-07-01T00:00:00.000Z',
    });
    fetchWithRetrySpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => fixtureOk,
    });
    const first = await mistral.fetchQuota();
    expect(first.ok).toBe(true);
    expect(first.isStale).toBeFalsy();

    // Second call: transient throw (network) -> stale fallback.
    fetchWithRetrySpy.mockRejectedValueOnce(new Error('Network request failed'));
    const second = await mistral.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
    expect(second.usage).toBeTruthy();

    // Third call: non-ok 401 -> no fallback, surfaces the error.
    fetchWithRetrySpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });
    const third = await mistral.fetchQuota();
    expect(third.ok).toBe(false);
    expect(third.configured).toBe(true);
    expect(third.error).toMatch(/401/);
  });
});
