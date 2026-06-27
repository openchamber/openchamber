import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as authModule from '../../opencode/auth.js';
import * as claude from './claude.js';

// Sanitized canonical Anthropic OAuth/usage response shapes (fake token
// values, realistic numeric fields). Mirrors the contracts ported from
// mystatus/plugin/mystatus.ts:
//
//   POST https://console.anthropic.com/v1/oauth/token
//     form: grant_type=refresh_token, refresh_token, client_id
//     -> { access_token, refresh_token?, expires_in? }
//   GET  https://api.anthropic.com/api/oauth/usage
//     headers: Authorization: Bearer <access>, anthropic-beta: oauth-2025-04-20,
//              User-Agent: claude-code/1.0.17, Content-Type: application/json
//     -> AnthropicUsageResponse {
//          five_hour?: { utilization, resets_at },
//          seven_day?: { utilization, resets_at },
//          seven_day_opus?: { utilization, resets_at } | null,
//          seven_day_sonnet?: { utilization, resets_at } | null,
//          seven_day_cowork?: { utilization, resets_at } | null,
//          extra_usage?: { is_enabled, monthly_limit, used_credits, utilization, currency } | null,
//        }
//
// Auth entry (auth.json key 'anthropic'):
//   { type: 'oauth', access: '<jwt>', refresh: '<refresh>', expires: <epoch ms> }

// Fake JWT with a stable `sub` claim for accountKey derivation.
// Header.{"sub":"acct-fake-123"}.sig — base64url payload is deterministic.
const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
  JSON.stringify({ sub: 'acct-fake-123' })
).toString('base64url')}.sig-fake`;

const FAKE_JWT_EXPIRED = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
  JSON.stringify({ sub: 'acct-fake-123' })
).toString('base64url')}.sig-stale`;

const REFRESH_RESPONSE = { access_token: FAKE_JWT, refresh_token: 'fake.refresh.rotated', expires_in: 3600 };

// Canonical usage fixture: every window populated with distinct utilization
// values so the test can assert each window maps independently.
//   five_hour:        utilization=40 -> usedPercent 40, remaining 60
//   seven_day:        utilization=70 -> usedPercent 70, remaining 30
//   seven_day_sonnet:utilization=20 -> usedPercent 20, remaining 80
//   seven_day_opus:  utilization=90 -> usedPercent 90, remaining 10
//   seven_day_cowork:utilization=15 -> usedPercent 15, remaining 85
const USAGE_RESPONSE = {
  five_hour: { utilization: 40, resets_at: '2026-06-26T18:00:00.000Z' },
  seven_day: { utilization: 70, resets_at: '2026-07-03T12:00:00.000Z' },
  seven_day_sonnet: { utilization: 20, resets_at: '2026-07-03T12:00:00.000Z' },
  seven_day_opus: { utilization: 90, resets_at: '2026-07-03T12:00:00.000Z' },
  seven_day_cowork: { utilization: 15, resets_at: '2026-07-03T12:00:00.000Z' },
  extra_usage: {
    is_enabled: true,
    monthly_limit: 100,
    used_credits: 25,
    utilization: 25,
    currency: 'USD',
  },
};

const OAUTH_AUTH = {
  anthropic: {
    type: 'oauth',
    access: FAKE_JWT,
    refresh: 'fake.refresh.token',
    expires: Date.now() + 3600_000,
  },
};

const OAUTH_AUTH_EXPIRED = {
  anthropic: {
    type: 'oauth',
    access: FAKE_JWT_EXPIRED,
    refresh: 'fake.refresh.token',
    expires: Date.now() - 60_000,
  },
};

describe('claude quota provider (Anthropic OAuth)', () => {
  let fetchSpy;
  let loadAuthMergedSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    loadAuthMergedSpy = vi.spyOn(authModule, 'loadAuthMerged');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when no auth entry', () => {
    loadAuthMergedSpy.mockReturnValue({});
    expect(claude.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when anthropic oauth entry has access token', () => {
    loadAuthMergedSpy.mockReturnValue(OAUTH_AUTH);
    expect(claude.isConfigured()).toBe(true);
  });

  it('isConfigured returns true via claude alias key', () => {
    loadAuthMergedSpy.mockReturnValue({ claude: OAUTH_AUTH.anthropic });
    expect(claude.isConfigured()).toBe(true);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    loadAuthMergedSpy.mockReturnValue({});
    const result = await claude.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
  });

  it('transforms canonical oauth/usage response into correct windows (no refresh needed)', async () => {
    loadAuthMergedSpy.mockReturnValue(OAUTH_AUTH);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => USAGE_RESPONSE,
    });

    const result = await claude.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Single fetch — the usage endpoint. No refresh since token is valid.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
    expect(opts.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(opts.headers['User-Agent']).toBe('claude-code/1.0.17');
    expect(opts.headers['Content-Type']).toBe('application/json');

    // accountKey derived from JWT sub claim.
    expect(result.accountKey).toBe('acct-fake-123');

    const windows = result.usage.windows;
    // All five canonical windows present.
    expect(Object.keys(windows).sort()).toEqual(
      ['5h', '7d', '7d-cowork', '7d-opus', '7d-sonnet'].sort(),
    );

    // five_hour: utilization=40 -> usedPercent 40, remaining 60.
    expect(windows['5h'].usedPercent).toBe(40);
    expect(windows['5h'].remainingPercent).toBe(60);
    expect(windows['5h'].suffix).toBe('rolling 5h');
    expect(windows['5h'].trendKey).toBe('claude:5h');
    // toTimestamp converts ISO string -> epoch ms.
    expect(windows['5h'].resetAt).toBe(Date.parse('2026-06-26T18:00:00.000Z'));

    // seven_day: utilization=70 -> usedPercent 70, remaining 30.
    expect(windows['7d'].usedPercent).toBe(70);
    expect(windows['7d'].remainingPercent).toBe(30);
    expect(windows['7d'].suffix).toBe('7-day all models');
    expect(windows['7d'].trendKey).toBe('claude:7d');

    // seven_day_sonnet: utilization=20 -> usedPercent 20, remaining 80.
    expect(windows['7d-sonnet'].usedPercent).toBe(20);
    expect(windows['7d-sonnet'].remainingPercent).toBe(80);
    expect(windows['7d-sonnet'].suffix).toBe('7-day Sonnet');
    expect(windows['7d-sonnet'].trendKey).toBe('claude:7d-sonnet');

    // seven_day_opus: utilization=90 -> usedPercent 90, remaining 10.
    expect(windows['7d-opus'].usedPercent).toBe(90);
    expect(windows['7d-opus'].remainingPercent).toBe(10);
    expect(windows['7d-opus'].suffix).toBe('7-day Opus');
    expect(windows['7d-opus'].trendKey).toBe('claude:7d-opus');

    // seven_day_cowork: utilization=15 -> usedPercent 15, remaining 85.
    expect(windows['7d-cowork'].usedPercent).toBe(15);
    expect(windows['7d-cowork'].remainingPercent).toBe(85);
    expect(windows['7d-cowork'].suffix).toBe('7-day Cowork');
    expect(windows['7d-cowork'].trendKey).toBe('claude:7d-cowork');
  });

  it('refreshes an expired token before fetching usage', async () => {
    loadAuthMergedSpy.mockReturnValue(OAUTH_AUTH_EXPIRED);
    // refresh (POST), usage (GET).
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => REFRESH_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => USAGE_RESPONSE });

    const result = await claude.fetchQuota();

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls;

    // First call is the OAuth refresh.
    expect(calls[0][0]).toBe('https://console.anthropic.com/v1/oauth/token');
    expect(calls[0][1].method).toBe('POST');
    expect(calls[0][1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = String(calls[0][1].body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(body).toContain('refresh_token=fake.refresh.token');

    // Subsequent usage call uses the refreshed token.
    expect(calls[1][0]).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(calls[1][1].headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
  });

  it('returns ok:false when token expired and no refresh token available', async () => {
    loadAuthMergedSpy.mockReturnValue({
      anthropic: {
        type: 'oauth',
        access: FAKE_JWT_EXPIRED,
        expires: Date.now() - 1000,
      },
    });
    const result = await claude.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/expired/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok:false when refresh fails', async () => {
    loadAuthMergedSpy.mockReturnValue(OAUTH_AUTH_EXPIRED);
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await claude.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/expired/i);
  });

  it('returns ok:false on usage API error without stale fallback', async () => {
    loadAuthMergedSpy.mockReturnValue(OAUTH_AUTH);
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await claude.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/401/);
    expect(result.isStale).toBeUndefined();
  });

  it('handles partial usage response (only five_hour present)', async () => {
    loadAuthMergedSpy.mockReturnValue(OAUTH_AUTH);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 50, resets_at: '2026-06-26T18:00:00.000Z' },
      }),
    });

    const result = await claude.fetchQuota();
    expect(result.ok).toBe(true);
    const keys = Object.keys(result.usage.windows);
    expect(keys).toEqual(['5h']);
    expect(result.usage.windows['5h'].usedPercent).toBe(50);
    expect(result.usage.windows['5h'].remainingPercent).toBe(50);
  });

  it('handles empty usage response (no windows)', async () => {
    loadAuthMergedSpy.mockReturnValue(OAUTH_AUTH);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const result = await claude.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows).toEqual({});
  });
});