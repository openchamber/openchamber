import { afterEach, describe, expect, it, vi } from 'vitest';

const copilotAuth = vi.hoisted(() => ({ enterpriseUrl: null }));

vi.mock('../../opencode/auth.js', () => ({
  readOpenCodeCredentials: async () => ({
    'github-copilot': {
      access: 'test-token',
      ...(copilotAuth.enterpriseUrl ? { enterpriseUrl: copilotAuth.enterpriseUrl } : undefined),
    },
  }),
}));

import { fetchQuota, fetchQuotaAddon } from './copilot.js';

afterEach(() => {
  copilotAuth.enterpriseUrl = null;
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
  ])('uses the enterprise Copilot API for the %s', async (_name, fetchProviderQuota) => {
    copilotAuth.enterpriseUrl = 'https://ghe.example.com/';
    const fetchMock = vi.fn().mockResolvedValue(mockResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderQuota();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.ghe.example.com/copilot_internal/user',
      expect.any(Object),
    );
  });

  it('rejects malformed enterprise URLs without sending the credential', async () => {
    copilotAuth.enterpriseUrl = 'https://ghe.example.com/copilot';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid GitHub Copilot Enterprise URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['credentials in the authority', 'https://user@ghe.example.com/'],
    ['an explicit port', 'https://ghe.example.com:8443/'],
    ['a query string', 'https://ghe.example.com/?next=evil.example.com'],
    ['a non-HTTP scheme', 'file://ghe.example.com/'],
    ['a host that is not a DNS name', 'ghe_example.com'],
  ])('refuses %s instead of requesting a host derived from it', async (_case, enterpriseUrl) => {
    copilotAuth.enterpriseUrl = enterpriseUrl;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid GitHub Copilot Enterprise URL');
    expect(fetchMock).not.toHaveBeenCalled();
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
  ])('reports credits used and plan label for unlimited plans with usage for the %s', async (_name, fetchProviderQuota) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      copilot_plan: 'business',
      quota_reset_date: '2026-11-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: { unlimited: true, entitlement: -1, remaining: -1, credits_used: 3233 },
      },
    })));

    const result = await fetchProviderQuota();

    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('Copilot Business');
    expect(result.usage.windows.premium_interactions.usedPercent).toBeNull();
    expect(result.usage.windows.premium_interactions.creditsUsed).toBe(3233);
    expect(result.usage.windows.premium_interactions.valueLabel).toBeUndefined();
  });

  it.each([0, '3233.27', -1, '', '  ', 'invalid', null, undefined, Infinity])('handles unlimited credits_used %s in both providers', async (creditsUsed) => {
    for (const fetchProviderQuota of [fetchQuota, fetchQuotaAddon]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
        quota_snapshots: { premium_interactions: { unlimited: true, credits_used: creditsUsed } },
      })));
      const result = await fetchProviderQuota();
      const window = result.usage.windows.premium_interactions;
      const expected = creditsUsed === 0 ? 0 : creditsUsed === '3233.27' ? 3233.27 : undefined;
      expect(window.creditsUsed).toBe(expected);
      expect(window.valueLabel).toBe(expected === undefined ? 'Unlimited' : undefined);
      expect(window.usedPercent).toBeNull();
      expect(window.remainingPercent).toBeNull();
    }
  });

  it('returns null/omits plan label for unmapped plan/sku and handles can_signup_for_limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      copilot_plan: 'some_unknown_enterprise_tier',
      access_type_sku: 'unknown_sku',
      quota_snapshots: {
        premium_interactions: { unlimited: true },
      },
    })));
    const unmappedResult = await fetchQuota();
    expect(unmappedResult.planLabel).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      copilot_plan: 'business',
      can_signup_for_limited: true,
      quota_snapshots: {
        premium_interactions: { unlimited: true },
      },
    })));
    const paidWithSignupResult = await fetchQuota();
    expect(paidWithSignupResult.planLabel).toBe('Copilot Business');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      can_signup_for_limited: true,
      quota_snapshots: {
        premium_interactions: { unlimited: false, entitlement: 50, remaining: 50 },
      },
    })));
    const freeSignupResult = await fetchQuota();
    expect(freeSignupResult.planLabel).toBe('Copilot Free');
  });

  it('keeps Unlimited value label when has_quota is false despite credits_used', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      copilot_plan: 'business',
      quota_snapshots: {
        premium_interactions: { unlimited: true, has_quota: false, credits_used: 1200 },
      },
    })));
    const result = await fetchQuota();
    expect(result.usage.windows.premium_interactions.valueLabel).toBe('Unlimited');
    expect(result.usage.windows.premium_interactions.creditsUsed).toBeUndefined();
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
