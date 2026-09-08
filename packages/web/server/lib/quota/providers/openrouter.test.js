import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ openrouter: { key: 'test-token' } }),
}));

import { fetchQuota, resolveResetAt } from './openrouter.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Documented payload shape from https://openrouter.ai/docs/api_reference/limits
const DOCUMENTED_PAYLOAD = {
  data: {
    label: 'Default',
    limit: 30,
    limit_remaining: 25,
    limit_reset: 'monthly',
    include_byok_in_limit: false,
    usage: 5,
    usage_daily: 1,
    usage_weekly: 3,
    usage_monthly: 5,
    byok_usage: 0,
    byok_usage_daily: 0,
    byok_usage_weekly: 0,
    byok_usage_monthly: 0,
    is_free_tier: false,
    is_management_key: false,
    is_provisioning_key: false,
    creator_user_id: 'user-fixture',
    expires_at: null,
    rate_limit: null
  }
};

const expectMonthlyReset = (resetAt) => {
  expect(resetAt).toEqual(expect.any(Number));
  const resetDate = new Date(resetAt);
  expect(resetDate.getUTCDate()).toBe(1);
  expect(resetDate.getUTCHours()).toBe(0);
  expect(resetAt - Date.now()).toBeGreaterThan(0);
  expect(resetAt - Date.now()).toBeLessThanOrEqual(31 * 86400 * 1000);
};

describe('OpenRouter quota provider', () => {
  it('builds a monthly window from the documented payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD)));

    const result = await fetchQuota();
    const window = result.usage.windows.monthly;

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('openrouter');
    expect(window.usedPercent).toBeCloseTo(16.6667, 3);
    expect(window.valueLabel).toBe('$5.00 / $30.00');
    expect(window.windowSeconds).toBe(30 * 86400);
    expectMonthlyReset(window.resetAt);
  });

  it('uses the daily window and preserves the observed funded-key values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: {
        usage: 3.17561396,
        usage_daily: 0.0000018,
        usage_weekly: 0.0000018,
        usage_monthly: 3.17561396,
        limit: 30,
        limit_remaining: 29.9999982,
        limit_reset: 'daily',
        is_free_tier: true,
        is_management_key: false,
        include_byok_in_limit: false,
        byok_usage: 0
      }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.daily;

    expect(window).toBeDefined();
    expect(window.windowSeconds).toBe(86400);
    expect(window.valueLabel).toBe('$0.00 / $30.00');
    expect(window.usedPercent).toBeLessThan(0.001);
    expect(window.resetAt % 86400000).toBe(0);
    expect(window.resetAt - Date.now()).toBeGreaterThan(0);
    expect(window.resetAt - Date.now()).toBeLessThanOrEqual(86400000);
  });

  it('builds a monthly unlimited window from null limit fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: {
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        usage_monthly: 3.17561396,
        is_management_key: false
      }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.monthly;

    expect(window.usedPercent).toBeNull();
    expect(window.valueLabel).toBe('$3.18 spent');
    expect(window.windowSeconds).toBe(30 * 86400);
    expectMonthlyReset(window.resetAt);
  });

  it('uses a credits window for a lifetime cap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: null, usage_monthly: 5 }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.credits;

    expect(window).toBeDefined();
    expect(window.resetAt).toBeNull();
    expect(window.windowSeconds).toBeNull();
  });

  it('uses a credits window for an unrecognized reset period', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: 'yearly', usage_monthly: 5 }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.credits;

    expect(window).toBeDefined();
    expect(window.resetAt).toBeNull();
    expect(window.windowSeconds).toBeNull();
  });

  it('builds a weekly window from a weekly limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: 'weekly', usage_monthly: 5 }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.weekly;

    expect(window).toBeDefined();
    expect(window.windowSeconds).toBe(604800);
    expect(new Date(window.resetAt).getUTCDay()).toBe(1);
    expect(window.resetAt - Date.now()).toBeGreaterThan(0);
    expect(window.resetAt - Date.now()).toBeLessThanOrEqual(7 * 86400 * 1000);
  });

  it('ignores BYOK usage when calculating the quota label and percent', async () => {
    const withByokPayload = {
      ...DOCUMENTED_PAYLOAD,
      data: {
        ...DOCUMENTED_PAYLOAD.data,
        include_byok_in_limit: true,
        byok_usage_monthly: 100,
        byok_usage: 100
      }
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(DOCUMENTED_PAYLOAD))
      .mockResolvedValueOnce(mockResponse(withByokPayload));
    vi.stubGlobal('fetch', fetchMock);

    const withoutByok = await fetchQuota();
    const withByok = await fetchQuota();

    expect(withByok.usage.windows.monthly.valueLabel)
      .toBe(withoutByok.usage.windows.monthly.valueLabel);
    expect(withByok.usage.windows.monthly.usedPercent)
      .toBe(withoutByok.usage.windows.monthly.usedPercent);
  });

  it('rejects management keys with a specific error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { is_management_key: true }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('Management key configured — quota needs an inference API key');
  });

  it.each([401, 403])('maps %s to a session-expired error', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with OpenRouter');
  });

  it('reports invalid-response on JSON parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid response from provider');
  });

  it('reports a normalized timeout error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request timed out');
  });

  it('returns no-quota-data when data is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({})));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it('returns no-quota-data when data is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ data: {} })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it.each([null, []])('returns no-quota-data when data is %s', async (data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ data })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('No quota data in response');
  });

  it('returns no-quota-data when a limit has no remaining value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: null, usage_monthly: 5 }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No quota data in response');
  });

  it('keeps a zero limit valid with a null percent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 0, limit_remaining: 0, limit_reset: 'monthly', usage_monthly: 0 }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.monthly;

    expect(result.ok).toBe(true);
    expect(window.usedPercent).toBeNull();
    expect(window.valueLabel).toBe('$0.00 / $0.00');
  });

  it('requests the key endpoint and never the credits endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    const requestedUrl = fetchMock.mock.calls[0][0];
    expect(requestedUrl).toBe('https://openrouter.ai/api/v1/key');
    expect(requestedUrl).not.toContain('/api/v1/credits');
  });

  it('resolves daily reset at the next UTC day across year boundaries', () => {
    expect(resolveResetAt('daily', Date.UTC(2024, 11, 31, 23, 59))).toBe(Date.UTC(2025, 0, 1));
  });

  it('resolves weekly reset from Sunday to the next Monday', () => {
    expect(resolveResetAt('weekly', Date.UTC(2024, 0, 7, 12))).toBe(Date.UTC(2024, 0, 8));
  });

  it('resolves weekly reset from Monday to the following Monday', () => {
    expect(resolveResetAt('weekly', Date.UTC(2024, 0, 8, 12))).toBe(Date.UTC(2024, 0, 15));
  });

  it('resolves weekly reset from Wednesday to the next Monday', () => {
    expect(resolveResetAt('weekly', Date.UTC(2024, 0, 10, 12))).toBe(Date.UTC(2024, 0, 15));
  });

  it('resolves monthly reset from January 31 to February 1', () => {
    expect(resolveResetAt('monthly', Date.UTC(2024, 0, 31, 12))).toBe(Date.UTC(2024, 1, 1));
  });

  it('resolves monthly reset across December to January', () => {
    expect(resolveResetAt('monthly', Date.UTC(2024, 11, 31, 23, 59))).toBe(Date.UTC(2025, 0, 1));
  });

  it('clamps percent at 100 while leaving the money label unclamped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: -1, limit_reset: 'monthly', usage_monthly: 31 }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.monthly;

    expect(window.usedPercent).toBe(100);
    expect(window.valueLabel).toBe('$31.00 / $30.00');
  });
});
