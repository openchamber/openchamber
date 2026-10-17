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
    premium_interactions: { entitlement: 300, remaining: 225 },
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
    expect(result.usage.windows.premium_interactions.usedPercent).toBe(25);
    expect(result.usage.windows.premium_interactions.valueLabel).toBe('225 / 300 left');
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
