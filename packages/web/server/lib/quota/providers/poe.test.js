import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as authModule from '../../opencode/auth.js';
import * as fetchUtils from '../utils/fetch.js';
import * as poe from './poe.js';

// Poe resolves its API key from OpenCode auth.json (the `poe` entry:
// access -> refresh -> key) or the POE_API_KEY env var — never a manual
// credential. Balance API shape (https://api.poe.com/usage/current_balance)
// ported from mystatus/plugin/mystatus.ts (PoeBalanceResponse):
//   current_point_balance?, plan_points_balance?, addon_point_balance?,
//   total_balance_usd?, next_daily_grant_time?, next_daily_grant_amount?,
//   next_monthly_grant_time?, next_monthly_grant_amount?
// Auth: `Authorization: Bearer <apiKey>`.

const API_KEY = 'fake-poe-api-key';

// current_point_balance=750, next_monthly_grant_amount=1000 -> remaining 75%,
// usedPercent 25%. Grant times in the future (ms epoch).
const NOW = Date.now();
const BALANCE_RESPONSE = {
  current_point_balance: 750,
  plan_points_balance: 700,
  addon_point_balance: 50,
  total_balance_usd: '7.50',
  next_daily_grant_time: NOW + 3_600_000,
  next_daily_grant_amount: 100,
  next_monthly_grant_time: NOW + 86_400_000 * 7,
  next_monthly_grant_amount: 1000,
};

describe('poe quota provider', () => {
  let loadAuthMergedSpy;
  let fetchSpy;
  let savedEnv;

  beforeEach(() => {
    loadAuthMergedSpy = vi.spyOn(authModule, 'loadAuthMerged');
    fetchSpy = vi.spyOn(fetchUtils, 'fetchWithRetry');
    savedEnv = process.env.POE_API_KEY;
    delete process.env.POE_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) delete process.env.POE_API_KEY;
    else process.env.POE_API_KEY = savedEnv;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when auth.json has no poe entry and no env', () => {
    loadAuthMergedSpy.mockReturnValue({});
    expect(poe.isConfigured()).toBe(false);
  });

  it('isConfigured returns true from auth.json poe.key', () => {
    loadAuthMergedSpy.mockReturnValue({ poe: { type: 'api', key: API_KEY } });
    expect(poe.isConfigured()).toBe(true);
  });

  it('isConfigured returns true from POE_API_KEY env when auth.json absent', () => {
    loadAuthMergedSpy.mockReturnValue({});
    process.env.POE_API_KEY = API_KEY;
    expect(poe.isConfigured()).toBe(true);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    loadAuthMergedSpy.mockReturnValue({});
    const result = await poe.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('prefers auth.json access over key', async () => {
    loadAuthMergedSpy.mockReturnValue({ poe: { type: 'oauth', access: 'access-tok', key: 'key-tok' } });
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => BALANCE_RESPONSE });
    await poe.fetchQuota();
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer access-tok');
  });

  it('transforms canonical current_balance into correct windows/footer', async () => {
    loadAuthMergedSpy.mockReturnValue({ poe: { type: 'api', key: API_KEY } });
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => BALANCE_RESPONSE });

    const result = await poe.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Single canonical endpoint called.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.poe.com/usage/current_balance');
    expect(opts.method).toBeUndefined(); // GET
    expect(opts.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(opts.headers.Accept).toBe('application/json');

    const windows = result.usage.windows;
    expect(Object.keys(windows).sort()).toEqual(['monthly']);

    const monthly = windows.monthly;
    // current=750, grant=1000 -> remaining 75%, usedPercent 25.
    expect(monthly.usedPercent).toBe(25);
    expect(monthly.remainingPercent).toBe(75);
    // resetAt derived from next_monthly_grant_time (canonical field).
    expect(typeof monthly.resetAt).toBe('string');
    expect(new Date(monthly.resetAt).getTime()).toBe(NOW + 86_400_000 * 7);
    // valueLabel carries the points balance (canonical header content).
    expect(typeof monthly.valueLabel).toBe('string');
    expect(monthly.valueLabel.includes('750')).toBe(true);
    // detail carries the "Points: X / Y" breakdown from canonical.
    expect(Array.isArray(monthly.detail)).toBe(true);
    expect(monthly.detail.some((l) => l.includes('750') && l.includes('1000'))).toBe(true);

    // Footer: add-on points line when addon_point_balance > 0.
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('50'))).toBe(true);
  });

  it('returns ok:false (no stale fallback) when balance API returns 401', async () => {
    loadAuthMergedSpy.mockReturnValue({ poe: { type: 'api', key: API_KEY } });
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await poe.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('falls back to stale cached result on transient failure after a prior success', async () => {
    loadAuthMergedSpy.mockReturnValue({ poe: { type: 'api', key: API_KEY } });
    // First call: success.
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => BALANCE_RESPONSE });
    const first = await poe.fetchQuota();
    expect(first.ok).toBe(true);

    // Second call: throws (network/retry exhausted).
    fetchSpy.mockRejectedValueOnce(new Error('Network request failed'));
    const second = await poe.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
  });

  it('handles missing monthly grant gracefully (no monthly window)', async () => {
    loadAuthMergedSpy.mockReturnValue({ poe: { type: 'api', key: API_KEY } });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        current_point_balance: 50,
        addon_point_balance: 0,
        total_balance_usd: '0.50',
        next_daily_grant_time: NOW + 3_600_000,
        next_daily_grant_amount: 100,
        // no next_monthly_grant_amount / next_monthly_grant_time
      }),
    });

    const result = await poe.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows).toEqual({});
  });
});
