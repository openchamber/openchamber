import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../opencode/auth.js', () => ({
  readOpenCodeCredentials: async () => ({ openrouter: { key: 'test-token' } }),
}));

// The quota base URL is resolved through the real config-layer reader. Point
// its global config directory at a path that does not exist so the machine's
// own opencode.json can never leak into these assertions; the custom layer is
// resolved from OPENCODE_CONFIG at call time, so each test stubs it fresh.
vi.hoisted(() => {
  process.env.OPENCODE_CONFIG_DIR = 'openrouter-quota-test-without-config-dir';
});

import { fetchQuota, resolveResetAt } from './openrouter.js';

const createdConfigPaths = [];

const stubCustomConfigPath = () => {
  const filePath = path.join(os.tmpdir(), `openrouter-quota-config-${process.pid}-${Math.random().toString(16).slice(2)}`);
  vi.stubEnv('OPENCODE_CONFIG', filePath);
  createdConfigPaths.push(filePath);
  return filePath;
};

const writeCustomConfig = (config) => {
  fs.writeFileSync(stubCustomConfigPath(), JSON.stringify(config));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const filePath of createdConfigPaths.splice(0)) {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
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
  it('builds a monthly cap and its spending total from the documented payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD)));

    const result = await fetchQuota();
    const cap = result.usage.windows.monthly;

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('openrouter');
    expect(cap.usedPercent).toBeCloseTo(16.6667, 3);
    expect(cap.valueLabel).toBe('$5.00 / $30.00');
    expect(cap.windowSeconds).toBe(30 * 86400);
    expectMonthlyReset(cap.resetAt);

    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: 5, limit: null });
    expect(result.usage.windows.monthly_credits.value).toEqual({ kind: 'spend', spent: 5, limit: null });
    expect(result.usage.windows.monthly_byok).toBeUndefined();
    expect(result.usage.windows.monthly_total.valueLabel).toBeUndefined();
  });

  it('uses the daily cap window and preserves the observed funded-key values', async () => {
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

    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: null, limit: null });
    expect(result.usage.windows.monthly_credits.value).toEqual({ kind: 'spend', spent: 3.17561396, limit: null });
    expect(result.usage.windows.monthly_byok.value).toEqual({ kind: 'spend', spent: null, limit: null });
  });

  it('builds the monthly total and categories when the key has no cap', async () => {
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
    const total = result.usage.windows.monthly_total;

    expect(result.usage.windows.monthly).toBeUndefined();
    expect(total.usedPercent).toBeNull();
    expect(total.value).toEqual({ kind: 'spend', spent: null, limit: null });
    expect(total.valueLabel).toBeUndefined();
    expect(total.windowSeconds).toBe(30 * 86400);
    expectMonthlyReset(total.resetAt);
    expect(result.usage.windows.monthly_credits.value).toEqual({ kind: 'spend', spent: 3.17561396, limit: null });
    expect(result.usage.windows.monthly_byok.value).toEqual({ kind: 'spend', spent: null, limit: null });
  });

  it('sums the captured monthly counters before display rounding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: {
        usage_monthly: 14.297788398,
        byok_usage_monthly: 212.345956722,
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        include_byok_in_limit: false,
        is_management_key: false
      }
    })));

    const result = await fetchQuota();
    const { monthly_total: total, monthly_credits: credits, monthly_byok: byok } = result.usage.windows;

    expect(total.value).toEqual({ kind: 'spend', spent: 226.64374512, limit: null });
    expect(credits.value).toEqual({ kind: 'spend', spent: 14.297788398, limit: null });
    expect(byok.value).toEqual({ kind: 'spend', spent: 212.345956722, limit: null });
    expect(total.value.spent).not.toBe(Math.round(14.30 * 100) / 100 + Math.round(212.35 * 100) / 100);
  });

  it('keeps exact-zero categories hidden while the zero total stays visible', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { usage_monthly: 0, byok_usage_monthly: 0, limit: null, limit_remaining: null, limit_reset: null }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows)).toEqual(['monthly_total']);
    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: 0, limit: null });
  });

  it.each([
    ['BYOK', { usage_monthly: 4, byok_usage_monthly: 'not-a-number' }, 4, null],
    ['Credits', { usage_monthly: null, byok_usage_monthly: 7 }, null, 7],
    ['blank BYOK', { usage_monthly: 4, byok_usage_monthly: ' ' }, 4, null],
    ['blank Credits', { usage_monthly: '', byok_usage_monthly: 7 }, null, 7]
  ])('keeps a valid category and marks an unreadable %s amount unknown', async (_label, counters, credits, byok) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { ...counters, limit: null, limit_remaining: null, limit_reset: null }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: null, limit: null });
    expect(result.usage.windows.monthly_credits.value).toEqual({ kind: 'spend', spent: credits, limit: null });
    expect(result.usage.windows.monthly_byok.value).toEqual({ kind: 'spend', spent: byok, limit: null });
  });

  it('uses a key_limit window for a lifetime cap and keeps monthly spending apart', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: null, usage_monthly: 5 }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.key_limit;

    expect(window).toBeDefined();
    expect(window.resetAt).toBeNull();
    expect(window.windowSeconds).toBeNull();
    expect(result.usage.windows.monthly_total).toBeDefined();
  });

  it('uses a key_limit window for an unrecognized reset period', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: 'yearly', usage_monthly: 5 }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.key_limit;

    expect(window).toBeDefined();
    expect(window.resetAt).toBeNull();
    expect(window.windowSeconds).toBeNull();
    expect(result.usage.windows.monthly_total).toBeDefined();
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
    expect(result.usage.windows.monthly_total).toBeDefined();
    expectMonthlyReset(result.usage.windows.monthly_total.resetAt);
  });

  it.each([
    { includeByok: false, limitRemaining: 25, capUsed: 5 },
    { includeByok: true, limitRemaining: -75, capUsed: 105 }
  ])('keeps cap usage at limit minus remaining when include_byok_in_limit is $includeByok', async ({ includeByok, limitRemaining, capUsed }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: {
        limit: 30,
        limit_remaining: limitRemaining,
        limit_reset: 'monthly',
        include_byok_in_limit: includeByok,
        usage_monthly: 5,
        byok_usage_monthly: 100
      }
    })));

    const result = await fetchQuota();
    const cap = result.usage.windows.monthly;

    expect(cap.valueLabel).toBe(`$${capUsed.toFixed(2)} / $30.00`);
    expect(cap.usedPercent).toBe(Math.min(100, (capUsed / 30) * 100));
    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: 105, limit: null });
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

  it('returns no-quota-data when a limit has no remaining value and no monthly counters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: null }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No quota data in response');
  });

  it('keeps usable monthly counters and shows a set cap as unknown when its remaining amount is unreadable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: null, limit_reset: 'monthly', usage_monthly: 5, byok_usage_monthly: 2 }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.monthly.usedPercent).toBeNull();
    expect(result.usage.windows.monthly.valueLabel).toBeUndefined();
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'spend', spent: null, limit: 30 });
    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: 7, limit: null });
    expect(result.usage.windows.monthly_credits.value).toEqual({ kind: 'spend', spent: 5, limit: null });
    expect(result.usage.windows.monthly_byok.value).toEqual({ kind: 'spend', spent: 2, limit: null });
  });

  it('treats a blank remaining amount as unreadable rather than a fully spent cap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: '  ', limit_reset: 'monthly', usage_monthly: 5, byok_usage_monthly: 2 }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.monthly.usedPercent).toBeNull();
    expect(result.usage.windows.monthly.value).toEqual({ kind: 'spend', spent: null, limit: 30 });
  });

  it('keeps a usable cap and shows both monthly counters unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: 'monthly', usage_monthly: 'bad', byok_usage_monthly: -1 }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows)).toEqual(['monthly', 'monthly_total', 'monthly_credits', 'monthly_byok']);
    expect(result.usage.windows.monthly.valueLabel).toBe('$5.00 / $30.00');
    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: null, limit: null });
    expect(result.usage.windows.monthly_credits.value).toEqual({ kind: 'spend', spent: null, limit: null });
    expect(result.usage.windows.monthly_byok.value).toEqual({ kind: 'spend', spent: null, limit: null });
  });

  it('keeps a usable cap when both monthly counters are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 30, limit_remaining: 25, limit_reset: 'monthly' }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows)).toEqual(['monthly', 'monthly_total', 'monthly_credits', 'monthly_byok']);
    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: null, limit: null });
    expect(result.usage.windows.monthly_credits.value).toEqual({ kind: 'spend', spent: null, limit: null });
    expect(result.usage.windows.monthly_byok.value).toEqual({ kind: 'spend', spent: null, limit: null });
  });

  it('keeps a zero limit valid with a null percent and a zero monthly total', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: { limit: 0, limit_remaining: 0, limit_reset: 'monthly', usage_monthly: 0, byok_usage_monthly: 0 }
    })));

    const result = await fetchQuota();
    const window = result.usage.windows.monthly;

    expect(result.ok).toBe(true);
    expect(window.usedPercent).toBeNull();
    expect(window.valueLabel).toBe('$0.00 / $0.00');
    expect(result.usage.windows.monthly_total.value).toEqual({ kind: 'spend', spent: 0, limit: null });
    expect(result.usage.windows.monthly_credits).toBeUndefined();
    expect(result.usage.windows.monthly_byok).toBeUndefined();
  });

  it('requests the key endpoint and never the credits endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    const requestedUrl = fetchMock.mock.calls[0][0];
    expect(requestedUrl).toBe('https://openrouter.ai/api/v1/key');
    expect(requestedUrl).not.toContain('/api/v1/credits');
  });

  it('reads the key endpoint from the configured v2 provider baseURL', async () => {
    writeCustomConfig({
      providers: {
        openrouter: { settings: { baseURL: 'https://gateway.example.com/v1' } },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example.com/v1/key');
  });

  it('reads the key endpoint from the legacy provider options baseURL', async () => {
    writeCustomConfig({
      provider: {
        openrouter: { options: { baseURL: 'https://legacy.example.com/v1' } },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    expect(fetchMock.mock.calls[0][0]).toBe('https://legacy.example.com/v1/key');
  });

  it('reads the key endpoint from the legacy provider api field', async () => {
    writeCustomConfig({
      provider: {
        openrouter: { api: 'https://legacy-api.example.com/v1' },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    expect(fetchMock.mock.calls[0][0]).toBe('https://legacy-api.example.com/v1/key');
  });

  it('keeps a legacy baseURL when the v2 entry has no address', async () => {
    writeCustomConfig({
      providers: {
        openrouter: { models: { 'openai/gpt-5': {} } },
      },
      provider: {
        openrouter: { options: { baseURL: 'https://legacy.example.com/v1' } },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    expect(fetchMock.mock.calls[0][0]).toBe('https://legacy.example.com/v1/key');
  });

  it('strips trailing slashes from the configured baseURL', async () => {
    writeCustomConfig({
      providers: {
        openrouter: { settings: { baseURL: 'https://gateway.example.com/v1/' } },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example.com/v1/key');
  });

  it('keeps the default key endpoint when no baseURL is configured', async () => {
    stubCustomConfigPath();
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/key');
  });

  it('keeps the default key endpoint when the config cannot be read', async () => {
    fs.mkdirSync(stubCustomConfigPath());
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/key');
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
