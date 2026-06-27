import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authModule from '../../opencode/auth.js';
import { fetchQuota, isConfigured } from './zai.js';

// Sanitized canonical response shapes (fake token values, realistic numeric
// fields). Mirrors Z.AI API contracts ported from mystatus/plugin/mystatus.ts
// (lines 1730-1897):
//
//   GET https://api.z.ai/api/monitor/usage/quota/limit  -> ZaiQuotaResponse
//   GET https://api.z.ai/api/biz/subscription/list      -> ZaiSubscriptionResponse
//
// ZaiQuotaResponse = {
//   code: number, msg: string, success: boolean,
//   data: { limits: ZaiLimit[], level: string }
// }
// ZaiLimit = {
//   type: string, unit: number, number: number, usage?: number,
//   currentValue?: number, remaining?: number, percentage: number,
//   nextResetTime: number, usageDetails?: { modelCode: string, usage: number }[]
// }
// ZaiSubscriptionResponse = {
//   code: number, msg: string, success: boolean, data: ZaiSubscription[]
// }
// ZaiSubscription = {
//   id, productName, status, valid, autoRenew (number), actualPrice, renewPrice,
//   billingCycle, nextRenewTime, paymentType, inCurrentPeriod
// }
//
// Canonical headers (queryZai): Authorization: Bearer <key>, Accept: application/json,
// User-Agent: OpenCode-AllStatus/1.0. No Content-Type on GETs.
//
// Unit -> label mapping (ZAI_UNIT_LABELS):
//   3 -> "<n>-hour rolling"; 5 -> "Monthly" (n<30) or "<n/30>-month"; 6 -> "Weekly"
// Limits are sorted by unit weight: 3 (hourly) -> 6 (weekly) -> 5 (monthly) -> rest.
// nextResetTime is epoch seconds (heuristic: <1e12 -> seconds, else ms).

const ZAI_KEY = 'fake-zai-api-key';

// Three limits covering all canonical unit types. Sorted by weight the
// canonical order is: unit 3 (5-hour rolling), unit 6 (Weekly), unit 5 (Monthly).
// nextResetTime values are epoch seconds.
const QUOTA_RESPONSE = {
  code: 0,
  msg: 'ok',
  success: true,
  data: {
    level: 'pro',
    limits: [
      {
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        percentage: 40,
        nextResetTime: 1750000000 // epoch sec
      },
      {
        type: 'TIME_LIMIT',
        unit: 6,
        number: 1,
        usage: 30,
        remaining: 70,
        percentage: 30,
        nextResetTime: 1750600000, // epoch sec
        usageDetails: [
          { modelCode: 'glm-4.6', usage: 20 },
          { modelCode: 'glm-4.6-air', usage: 10 },
          { modelCode: 'glm-4.5-air', usage: 0 } // filtered out (usage=0)
        ]
      },
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        percentage: 10,
        nextResetTime: 1752000000 // epoch sec
      }
    ]
  }
};

const SUBSCRIPTION_RESPONSE = {
  code: 0,
  msg: 'ok',
  success: true,
  data: [
    {
      id: 'fake-sub-id',
      productName: 'GLM Coding Pro',
      status: 'VALID',
      valid: '2025-01-01 - 2025-12-31',
      autoRenew: 1,
      actualPrice: 19.99,
      renewPrice: 19.99,
      billingCycle: 'month',
      nextRenewTime: '2025-12-31T23:59:59Z',
      paymentType: 'card',
      inCurrentPeriod: true
    },
    {
      id: 'fake-expired-sub',
      productName: 'GLM Coding Starter',
      status: 'EXPIRED',
      valid: '2024-01-01 - 2024-12-31',
      autoRenew: 0,
      actualPrice: 4.99,
      renewPrice: 4.99,
      billingCycle: 'month',
      nextRenewTime: '2024-12-31T23:59:59Z',
      paymentType: 'card',
      inCurrentPeriod: false
    }
  ]
};

describe('zai quota provider', () => {
  let fetchSpy;
  let authSpy;

  beforeEach(() => {
    authSpy = vi.spyOn(authModule, 'readAuthFile').mockReturnValue({
      'zai-coding-plan': { type: 'api', key: ZAI_KEY }
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns true when auth.json has zai-coding-plan key', () => {
    expect(isConfigured()).toBe(true);
  });

  it('isConfigured returns true when auth.json has zai alias with token', () => {
    authSpy.mockReturnValue({ zai: { type: 'api', token: ZAI_KEY } });
    expect(isConfigured()).toBe(true);
  });

  it('isConfigured returns false when no credentials', () => {
    authSpy.mockReturnValue({});
    expect(isConfigured()).toBe(false);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    authSpy.mockReturnValue({});
    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.usage).toBeNull();
  });

  it('transforms canonical quota/limit + subscription/list into correct windows/header', async () => {
    // Both endpoints called in parallel; quota first in mock resolution order.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => QUOTA_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => SUBSCRIPTION_RESPONSE });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Two canonical endpoints called, both GET on https://api.z.ai.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls;
    const urls = calls.map((c) => c[0]);
    expect(urls).toContain('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(urls).toContain('https://api.z.ai/api/biz/subscription/list');
    for (const [, opts] of calls) {
      expect(opts.method).toBe('GET');
      expect(opts.headers.Authorization).toBe(`Bearer ${ZAI_KEY}`);
      expect(opts.headers.Accept).toBe('application/json');
      expect(opts.headers['User-Agent']).toBe('OpenCode-AllStatus/1.0');
      // Canonical does NOT send Content-Type on GETs.
      expect(opts.headers['Content-Type']).toBeUndefined();
    }

    const windows = result.usage.windows;
    // Three limits -> three windows with canonical unit labels.
    expect(Object.keys(windows).sort()).toEqual(['5-hour rolling', 'Monthly', 'Weekly']);

    // unit 3: 5-hour rolling, percentage 40 -> used 40, remaining 60.
    const hourly = windows['5-hour rolling'];
    expect(hourly.usedPercent).toBe(40);
    expect(hourly.remainingPercent).toBe(60);
    // nextResetTime epoch sec -> ISO string.
    expect(typeof hourly.resetAt).toBe('string');
    expect(new Date(hourly.resetAt).getTime()).toBe(1750000000 * 1000);
    expect(hourly.suffix).toBe('token quota');
    expect(hourly.trendKey).toBe('zai-coding-plan:5-hour rolling');

    // unit 6: Weekly, percentage 30 -> used 30, remaining 70.
    // TIME_LIMIT with usage/remaining -> detail line "Used: 30 / 100".
    // usageDetails with two models having usage>0 -> extra line.
    const weekly = windows.Weekly;
    expect(weekly.usedPercent).toBe(30);
    expect(weekly.remainingPercent).toBe(70);
    expect(new Date(weekly.resetAt).getTime()).toBe(1750600000 * 1000);
    expect(Array.isArray(weekly.detail)).toBe(true);
    expect(weekly.detail.some((l) => l.includes('Used: 30 / 100'))).toBe(true);
    expect(Array.isArray(weekly.extra)).toBe(true);
    expect(weekly.extra.some((l) => l.includes('glm-4.6: 20'))).toBe(true);
    expect(weekly.extra.some((l) => l.includes('glm-4.6-air: 10'))).toBe(true);
    // Filtered-out model (usage=0) must not appear.
    expect(weekly.extra.some((l) => l.includes('glm-4.5-air'))).toBe(false);

    // unit 5: Monthly (number 30 < 30 threshold -> "Monthly"), percentage 10.
    const monthly = windows.Monthly;
    expect(monthly.usedPercent).toBe(10);
    expect(monthly.remainingPercent).toBe(90);
    expect(new Date(monthly.resetAt).getTime()).toBe(1752000000 * 1000);

    // Header carries plan name + price + validity + auto-renew line from the
    // active (VALID + inCurrentPeriod) subscription.
    expect(Array.isArray(result.usage.header)).toBe(true);
    expect(result.usage.header.some((l) => l.includes('GLM Coding Pro'))).toBe(true);
    expect(result.usage.header.some((l) => l.includes('$19.99/month'))).toBe(true);
    expect(result.usage.header.some((l) => l.includes('Valid:'))).toBe(true);
    // autoRenew truthy (1) -> "Auto-renews:" line.
    expect(result.usage.header.some((l) => /Auto-renews:/.test(l))).toBe(true);
    expect(result.usage.header.some((l) => l.includes('2025-12-31T23:59:59Z'))).toBe(true);
    // Expired subscription must NOT appear.
    expect(result.usage.header.some((l) => l.includes('GLM Coding Starter'))).toBe(false);
  });

  it('uses "Expires:" instead of "Auto-renews:" when autoRenew is falsy', async () => {
    const noRenewSub = {
      ...SUBSCRIPTION_RESPONSE,
      data: [
        {
          ...SUBSCRIPTION_RESPONSE.data[0],
          autoRenew: 0,
          nextRenewTime: '2025-12-31T00:00:00Z'
        }
      ]
    };
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => QUOTA_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => noRenewSub });

    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.header.some((l) => /Expires:/.test(l))).toBe(true);
    expect(result.usage.header.some((l) => /Auto-renews:/.test(l))).toBe(false);
  });

  it('falls back to plan label from quota.data.level when subscription endpoint fails', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => QUOTA_RESPONSE })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    // No active subscription -> header uses GLM Coding (level) label only.
    expect(result.usage.header).toEqual(['Plan:           GLM Coding (pro)']);
    // Windows still populated from quota.
    expect(Object.keys(result.usage.windows).length).toBe(3);
  });

  it('falls back to plan label when subscription data has no active subscription', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => QUOTA_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, msg: 'ok', success: true, data: [] }) });

    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.header).toEqual(['Plan:           GLM Coding (pro)']);
  });

  it('returns ok:false when quota API returns HTTP error', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    // subRes is fetched in parallel; mock it too so Promise.all resolves.
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => SUBSCRIPTION_RESPONSE });

    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('401');
  });

  it('returns ok:false when quota API returns success:false', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 1, msg: 'token invalid', success: false, data: null })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => SUBSCRIPTION_RESPONSE });

    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('token invalid');
  });

  it('returns ok:false when quota data.limits is missing', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'ok', success: true, data: { level: 'free' } })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => SUBSCRIPTION_RESPONSE });

    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
  });

  it('handles empty limits array gracefully (no windows)', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'ok', success: true, data: { level: 'free', limits: [] } })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => SUBSCRIPTION_RESPONSE });

    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows).toEqual({});
    // Header still carries plan info.
    expect(result.usage.header.some((l) => l.includes('GLM Coding Pro'))).toBe(true);
  });

  it('returns ok:false on network failure (no stale fallback)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network request failed'));
    // subRes is fetched in parallel; it also rejects. Promise.all rejects
    // with the first rejection, which is caught by the try/catch.
    fetchSpy.mockRejectedValueOnce(new Error('Network request failed'));

    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('treats nextResetTime as epoch seconds when < 1e12 and ms when >= 1e12', async () => {
    const msResponse = {
      ...QUOTA_RESPONSE,
      data: {
        ...QUOTA_RESPONSE.data,
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 50,
            nextResetTime: 1750000000000 // epoch ms (>= 1e12)
          }
        ]
      }
    };
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => msResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => SUBSCRIPTION_RESPONSE });

    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    const hourly = result.usage.windows['5-hour rolling'];
    // ms value used directly (no *1000).
    expect(new Date(hourly.resetAt).getTime()).toBe(1750000000000);
  });

  it('returns null resetAt when nextResetTime is missing or invalid', async () => {
    const noResetResponse = {
      ...QUOTA_RESPONSE,
      data: {
        ...QUOTA_RESPONSE.data,
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 50 }
          // no nextResetTime
        ]
      }
    };
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => noResetResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => SUBSCRIPTION_RESPONSE });

    const result = await fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows['5-hour rolling'].resetAt).toBeNull();
  });
});