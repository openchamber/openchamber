import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ 'kimi-for-coding': { key: 'test-token' } }),
}));

import { fetchQuota } from './kimi.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

describe('Kimi for Coding quota provider', () => {
  it('computes weekly usedPercent from the used field (live API shape, no remaining field)', async () => {
    // Captured from GET https://api.kimi.com/coding/v1/usages — the weekly
    // `usage` block only ever includes `used`, never `remaining`.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({
        usage: { limit: '100', used: '100', resetTime: '2026-08-04T06:21:48.514003Z' },
        limits: [{
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '100', remaining: '100', resetTime: '2026-08-03T07:21:48.514003Z' },
        }],
      }),
    ));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.weekly.usedPercent).toBe(100);
    expect(result.usage.windows['Rate Limit (300m)'].usedPercent).toBe(0);
  });

  it('falls back to computing usedPercent from remaining when used is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({
        usage: { limit: '2048', remaining: '512', resetTime: '2026-08-04T06:21:48.514003Z' },
        limits: [],
      }),
    ));

    const result = await fetchQuota();

    expect(result.usage.windows.weekly.usedPercent).toBe(75);
  });

  it('prefers used over remaining when both fields are present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({
        usage: { limit: '100', used: '30', remaining: '999', resetTime: null },
        limits: [],
      }),
    ));

    const result = await fetchQuota();

    expect(result.usage.windows.weekly.usedPercent).toBe(30);
  });

  it('reports null usedPercent when neither used nor remaining is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({
        usage: { limit: '100', resetTime: null },
        limits: [],
      }),
    ));

    const result = await fetchQuota();

    expect(result.usage.windows.weekly.usedPercent).toBeNull();
  });

  it('reports not configured when no credentials are stored', async () => {
    vi.doMock('../../opencode/auth.js', () => ({ readAuthFile: () => ({}) }));
    vi.resetModules();
    const { fetchQuota: fetchQuotaFresh } = await import('./kimi.js');

    const result = await fetchQuotaFresh();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');

    vi.doUnmock('../../opencode/auth.js');
    vi.resetModules();
  });

  it('surfaces API errors with status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('API error: 401');
  });
});
