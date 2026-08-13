import { afterEach, describe, expect, it, vi } from 'vitest';

let mockBaseUrl = 'https://example.com/v1';
let mockAuth = { sub2api: { key: 'test-token' } };

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => mockAuth,
}));

vi.mock('../../opencode/shared.js', () => ({
  readConfig: () => ({ provider: { sub2api: { options: { baseURL: mockBaseUrl } } } }),
}));

import { fetchQuota, parseSub2ApiUsage, resolveSub2ApiBaseUrl } from './sub2api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  mockBaseUrl = 'https://example.com/v1';
  mockAuth = { sub2api: { key: 'test-token' } };
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

const QUOTA_LIMITED_PAYLOAD = {
  mode: 'quota_limited',
  isValid: true,
  status: 'active',
  quota: { limit: 100, used: 36.5, remaining: 63.5, unit: 'USD' },
  remaining: 63.5,
  unit: 'USD',
  rate_limits: [
    { window: '5h', limit: 10, used: 4, remaining: 6, window_start: '2026-08-13T00:00:00Z', reset_at: '2026-08-13T05:00:00Z' },
    { window: '7d', limit: 100, used: 40, remaining: 60, window_start: '2026-08-11T00:00:00Z', reset_at: '2026-08-18T00:00:00Z' },
  ],
  usage: {
    today: { requests: 10, input_tokens: 10000, output_tokens: 2000, cache_creation_tokens: 0, cache_read_tokens: 5000, total_tokens: 17000, cost: 0.5, actual_cost: 0.4 },
    total: { requests: 100, input_tokens: 100000, output_tokens: 20000, cache_creation_tokens: 0, cache_read_tokens: 50000, total_tokens: 170000, cost: 5, actual_cost: 4 },
    average_duration_ms: 1200,
    rpm: 1,
    tpm: 2000,
  },
  daily_usage: [],
  model_stats: [
    { model: 'gpt-example', requests: 20, input_tokens: 50000, output_tokens: 10000, cache_creation_tokens: 0, cache_read_tokens: 20000, total_tokens: 80000, cost: 2.5, actual_cost: 2, account_cost: 1.5 },
  ],
};

describe('resolveSub2ApiBaseUrl', () => {
  it('normalizes a /v1 base URL and trailing slashes to the bare origin', () => {
    mockBaseUrl = 'https://example.com/v1/';
    expect(resolveSub2ApiBaseUrl()).toBe('https://example.com');
  });

  it('keeps a base URL without a /v1 suffix untouched', () => {
    mockBaseUrl = 'https://example.com';
    expect(resolveSub2ApiBaseUrl()).toBe('https://example.com');
  });

  it('rejects non-HTTP(S) base URLs', () => {
    mockBaseUrl = 'ftp://example.com/v1';
    expect(resolveSub2ApiBaseUrl()).toBeNull();
  });
});

describe('parseSub2ApiUsage', () => {
  it('parses quota_limited total quota and every rate-limit window', () => {
    const { windows } = parseSub2ApiUsage(QUOTA_LIMITED_PAYLOAD);

    const total = windows.plan_limit;
    expect(total.usedPercent).toBeCloseTo(36.5, 4);
    expect(total.usedLabel).toBe('$36.50');
    expect(total.remainingLabel).toBe('$63.50');
    expect(total.windowSeconds).toBeNull();

    const fiveHour = windows['5h'];
    expect(fiveHour.usedPercent).toBe(40);
    expect(fiveHour.windowSeconds).toBe(5 * 60 * 60);
    expect(fiveHour.resetAt).toBe(Date.parse('2026-08-13T05:00:00Z'));
    expect(fiveHour.usedLabel).toBe('$4.00');
    expect(fiveHour.remainingLabel).toBe('$6.00');

    const sevenDay = windows['7d'];
    expect(sevenDay.usedPercent).toBe(40);
    expect(sevenDay.windowSeconds).toBe(7 * 24 * 60 * 60);
  });

  it('normalizes a 1d rate-limit window to the daily key', () => {
    const { windows } = parseSub2ApiUsage({
      mode: 'quota_limited',
      quota: { limit: 100, used: 10, remaining: 90, unit: 'USD' },
      rate_limits: [{ window: '1d', limit: 50, used: 25, remaining: 25 }],
    });

    expect(windows.daily.usedPercent).toBe(50);
    expect(windows.daily.windowSeconds).toBe(24 * 60 * 60);
  });

  it('keeps quota_exhausted and expired statuses as successful results', () => {
    const exhausted = parseSub2ApiUsage({ ...QUOTA_LIMITED_PAYLOAD, status: 'quota_exhausted' });
    expect(exhausted.status).toBe('quota_exhausted');
    expect(exhausted.windows.plan_limit).toBeDefined();

    const expired = parseSub2ApiUsage({ ...QUOTA_LIMITED_PAYLOAD, status: 'expired' });
    expect(expired.status).toBe('expired');
    expect(expired.windows.plan_limit).toBeDefined();
  });

  it('parses subscription limits independently with weekly reset', () => {
    const { windows } = parseSub2ApiUsage({
      mode: 'unrestricted',
      isValid: true,
      planName: 'Plan Name',
      unit: 'USD',
      remaining: 10,
      subscription: {
        daily_usage_usd: 1,
        weekly_usage_usd: 4,
        monthly_usage_usd: 12,
        daily_limit_usd: 5,
        weekly_limit_usd: 20,
        monthly_limit_usd: 50,
        weekly_window_start: '2026-08-10T00:00:00Z',
        expires_at: '2026-09-01T00:00:00Z',
      },
    });

    expect(windows.daily.usedPercent).toBe(20);
    expect(windows.weekly.usedPercent).toBe(20);
    expect(windows.weekly.resetAt).toBe(Date.parse('2026-08-17T00:00:00Z'));
    expect(windows.monthly.usedPercent).toBe(24);
    expect(windows.monthly.usedLabel).toBe('$12.00');
    expect(windows.monthly.remainingLabel).toBe('$38.00');

    const plan = windows['Plan Name'];
    expect(plan.usedPercent).toBeNull();
    expect(plan.valueLabel).toBe('$10.00');
  });

  it('parses a wallet response as a non-percent balance', () => {
    const { windows } = parseSub2ApiUsage({
      mode: 'unrestricted',
      isValid: true,
      planName: 'Wallet',
      remaining: 23.45,
      balance: 23.45,
      unit: 'USD',
    });

    expect(windows.credits_balance.usedPercent).toBeNull();
    expect(windows.credits_balance.valueLabel).toBe('$23.45');
    expect(windows.credits_balance.windowSeconds).toBeNull();
  });

  it('falls back to remaining when balance is absent', () => {
    const { windows } = parseSub2ApiUsage({
      mode: 'unrestricted',
      remaining: 5,
      unit: 'USD',
    });

    expect(windows.credits_balance.valueLabel).toBe('$5.00');
  });

  it('retains aggregate and per-model statistics with actual_cost', () => {
    const { statistics } = parseSub2ApiUsage(QUOTA_LIMITED_PAYLOAD);

    expect(statistics.unit).toBe('USD');
    expect(statistics.today.requests).toBe(10);
    expect(statistics.today.totalTokens).toBe(17000);
    expect(statistics.today.actualCost).toBe(0.4);
    expect(statistics.total.requests).toBe(100);
    expect(statistics.total.actualCost).toBe(4);
    expect(statistics.models['gpt-example'].requests).toBe(20);
    expect(statistics.models['gpt-example'].cacheReadTokens).toBe(20000);
    expect(statistics.models['gpt-example'].actualCost).toBe(2);
    expect(statistics.models['gpt-example'].account_cost).toBeUndefined();
  });

  it('omits statistics when usage and model_stats are missing', () => {
    const { statistics } = parseSub2ApiUsage({ mode: 'unrestricted', balance: 1, unit: 'USD' });
    expect(statistics).toBeNull();
  });

  it('tolerates unknown fields and absent optional blocks', () => {
    const { windows } = parseSub2ApiUsage({ mode: 'quota_limited', quota: { limit: 10, used: 1 }, extra: { nested: true } });
    expect(windows.plan_limit.usedPercent).toBe(10);
  });
});

describe('fetchQuota', () => {
  it('requests the normalized /v1/usage URL with Authorization only', async () => {
    let requestUrl;
    let requestHeaders;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url, init) => {
      requestUrl = url;
      requestHeaders = init.headers;
      return mockResponse({ mode: 'unrestricted', balance: 10, unit: 'USD' });
    }));

    const result = await fetchQuota();

    expect(requestUrl).toBe('https://example.com/v1/usage');
    expect(requestHeaders.Authorization).toBe('Bearer test-token');
    expect(requestHeaders.Accept).toBe('application/json');
    expect(requestHeaders['X-Gateway-Token']).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('reports not configured without an API key and never fetches', async () => {
    mockAuth = {};
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401 and 403 to authentication failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ code: 'INVALID_API_KEY' }) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Sub2API authentication failed');
  });

  it('maps 429 to an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Sub2API usage API returned HTTP 429');
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

  it('returns no-quota-data on a 200 payload with no usable windows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ mode: 'unrestricted' })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it('reports timeout failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request timed out');
  });
});
