import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readOpenCodeCredentials: async () => ({ 'github-copilot': { access: 'test-token' } }),
}));

import { fetchQuota, fetchQuotaAddon } from './copilot.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const payload = {
  quota_reset_date: '2026-09-01T00:00:00Z',
  quota_snapshots: {
    chat: { entitlement: 100, remaining: 80 },
    completions: { entitlement: 1000, remaining: 900 },
    premium_interactions: { entitlement: 60000, remaining: 39078, percent_remaining: 34.9 },
  },
};

const mockResponse = (body = payload) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('GitHub Copilot quota provider', () => {
  it.each([
    ['primary provider', fetchQuota],
    ['add-on provider', fetchQuotaAddon],
  ])('exposes only premium interactions for the %s', async (_name, fetchProviderQuota) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse()));

    const result = await fetchProviderQuota();

    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows)).toEqual(['premium_interactions']);
    expect(result.usage.windows.premium_interactions.usedPercent).toBeCloseTo(34.87);
    expect(result.usage.windows.premium_interactions.valueLabel).toBe('20,922 / 60,000 used');
  });

  it.each([
    ['primary provider', fetchQuota],
    ['add-on provider', fetchQuotaAddon],
  ])('derives the credit label from the same used axis as VS Code on fractional credits for the %s', async (_name, fetchProviderQuota) => {
    // The live Business-plan shape: `remaining` (39078) is the integer twin of
    // `quota_remaining` (39078.5). GitHub's own Copilot panel reports
    // 20,921.5 / 60,000 used for this snapshot, and the old label read
    // "39078 / 60000 left".
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      quota_reset_date: '2026-11-01T00:00:00.000Z',
      quota_snapshots: {
        premium_interactions: {
          overage_count: 0,
          overage_permitted: true,
          percent_remaining: 65.1,
          quota_remaining: 39078.5,
          unlimited: false,
          credits_used: 20910,
          remaining: 39078,
          entitlement: 60000,
        },
      },
    })));

    const result = await fetchProviderQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.premium_interactions.usedPercent).toBeCloseTo(34.87);
    expect(result.usage.windows.premium_interactions.valueLabel).toBe('20,921.5 / 60,000 used');
  });

  it.each([
    ['primary provider', fetchQuota],
    ['add-on provider', fetchQuotaAddon],
  ])('keeps the fractional credit rather than rounding it away for the %s', async (_name, fetchProviderQuota) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 100, quota_remaining: 65.27 },
      },
    })));

    const result = await fetchProviderQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.premium_interactions.valueLabel).toBe('34.7 / 100 used');
  });

  it.each([
    ['primary provider', fetchQuota],
    ['add-on provider', fetchQuotaAddon],
  ])('reports unlimited plans without a percent for the %s', async (_name, fetchProviderQuota) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { unlimited: true, entitlement: -1, remaining: -1 },
      },
    })));

    const result = await fetchProviderQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.premium_interactions.usedPercent).toBeNull();
    expect(result.usage.windows.premium_interactions.valueLabel).toBe('Unlimited');
  });

  it.each([
    ['primary provider', fetchQuota],
    ['add-on provider', fetchQuotaAddon],
  ])('falls back to percent_remaining when entitlement is unusable for the %s', async (_name, fetchProviderQuota) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      quota_reset_date: '2026-09-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 75.5 },
      },
    })));

    const result = await fetchProviderQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.premium_interactions.usedPercent).toBeCloseTo(24.5);
    expect(result.usage.windows.premium_interactions.valueLabel ?? null).toBeNull();
  });
});
