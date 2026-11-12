import { describe, expect, it } from 'vitest';
import { fetchQuota } from './nanogpt.js';

const run = (payload) => fetchQuota({
  readAuth: () => ({ 'nano-gpt': { key: 'test-token' } }),
  fetchImpl: async (url, options) => {
    expect(url).toBe('https://nano-gpt.com/api/subscription/v1/usage');
    expect(options.headers.Authorization).toBe('Bearer test-token');
    return Response.json(payload);
  },
});

describe('NanoGPT quota provider', () => {

  it('reads daily and weekly token quotas with millisecond reset times', async () => {
    const result = await run({
      state: 'active', limits: { dailyInputTokens: 1000, weeklyInputTokens: 10000 },
      dailyInputTokens: { used: 100, percentUsed: 0.1, resetAt: 1893542400000 },
      weeklyInputTokens: { used: 2500, percentUsed: 0.25, resetAt: 1893974400000 },
    });
    expect(result.ok).toBe(true);
    expect(result.usage?.windows.daily?.usedPercent).toBe(10);
    expect(result.usage?.windows.daily?.resetAt).toBe(1893542400000);
    expect(result.usage?.windows.weekly?.usedPercent).toBe(25);
    expect(result.usage?.windows.weekly?.windowSeconds).toBe(604800);
    expect(result.usage?.windows.weekly?.resetAt).toBe(1893974400000);
  });

  it('reads a weekly-only subscription and computes usage from its top-level limit', async () => {
    const result = await run({
      limits: { dailyInputTokens: null, weeklyInputTokens: 10000 },
      dailyInputTokens: null, weeklyInputTokens: { used: 2500 },
    });
    expect(Object.keys(result.usage?.windows ?? {}).join(',')).toBe('weekly');
    expect(result.usage?.windows.weekly?.usedPercent).toBe(25);
  });

  it('prefers current daily quotas over legacy fields and uses the token limit', async () => {
    const result = await run({
      limits: { dailyInputTokens: 1000 },
      dailyInputTokens: { used: 300 }, daily: { percentUsed: 0.9 },
    });
    expect(result.usage?.windows.daily?.usedPercent).toBe(30);
  });

  it('keeps unavailable quota reads unknown', async () => {
    const result = await run({
      limits: { dailyInputTokens: 1000, weeklyInputTokens: 10000 },
      dailyInputTokens: { used: null, percentUsed: null, resetAt: null, degraded: true },
      weeklyInputTokens: { used: null, percentUsed: null, resetAt: null, degraded: true },
    });
    expect(result.usage?.windows.daily?.usedPercent).toBe(null);
    expect(result.usage?.windows.weekly?.usedPercent).toBe(null);
    expect(result.usage?.windows.weekly?.remainingPercent).toBe(null);
  });

  it('preserves zero and clamps exhausted quotas', async () => {
    const result = await run({
      dailyInputTokens: { percentUsed: 0 }, weeklyInputTokens: { percentUsed: 1.1 },
    });
    expect(result.usage?.windows.daily?.usedPercent).toBe(0);
    expect(result.usage?.windows.weekly?.usedPercent).toBe(100);
  });

  it('preserves legacy daily and monthly response support', async () => {
    const result = await run({
      state: 'grace', period: { currentPeriodEnd: 1893974400000 },
      daily: { percentUsed: 0.4 }, monthly: { used: 50, limit: 100 },
    });
    expect(result.usage?.windows.daily?.usedPercent).toBe(40);
    expect(result.usage?.windows.monthly?.usedPercent).toBe(50);
    expect(result.usage?.windows.monthly?.resetAt).toBe(1893974400000);
    expect(result.usage?.windows.daily?.valueLabel).toBe('(grace)');
  });

  it('does not invent quotas when the account has none', async () => {
    const result = await run({ active: false, dailyInputTokens: null, weeklyInputTokens: null });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage?.windows ?? {}).length).toBe(0);
  });

  it('reports HTTP failures rather than empty success', async () => {
    const result = await fetchQuota({
      readAuth: () => ({ 'nano-gpt': { key: 'test-token' } }),
      fetchImpl: async () => new Response(null, { status: 401 }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 401');
  });
  it('does not revive a legacy daily cap when the current cap is null', async () => {
    const result = await run({ dailyInputTokens: null, daily: { percentUsed: 0.9 } });
    expect(Object.keys(result.usage?.windows ?? {}).length).toBe(0);
  });

  it('rejects malformed quota responses instead of reporting empty success', async () => {
    const result = await run({ weeklyInputTokens: 'invalid' });
    expect(result.ok).toBe(false);
  });

});
