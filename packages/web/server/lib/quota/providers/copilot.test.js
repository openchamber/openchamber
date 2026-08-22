import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ 'github-copilot': { access: 'test-token' } }),
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
    premium_interactions: { entitlement: 300, remaining: 225 },
  },
};

const mockResponse = () => ({
  ok: true,
  status: 200,
  json: async () => payload,
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
});
