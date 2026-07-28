import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ neuralwatt: { key: 'test-token' } }),
}));

import { fetchQuota } from './neuralwatt.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Documented payload shape from https://portal.neuralwatt.com/docs/api/quota
// Subscription has kwh_included=20.0, kwh_used=13.9023, plan="standard".
const DOCUMENTED_SUBSCRIPTION_PAYLOAD = {
  snapshot_at: '2026-04-16T18:30:00Z',
  balance: { credits_remaining_usd: 32.6774, total_credits_usd: 52.34, credits_used_usd: 19.6626, accounting_method: 'energy' },
  usage: { lifetime: { cost_usd: 243.9145, requests: 37801, tokens: 1235477176, energy_kwh: 15.6009 }, current_month: { cost_usd: 160.1463, requests: 23902, tokens: 1116658995, energy_kwh: 9.7278 } },
  limits: { overage_limit_usd: null, rate_limit_tier: 'standard' },
  subscription: {
    plan: 'standard',
    status: 'active',
    billing_interval: 'year',
    current_period_start: '2026-04-11T05:05:25Z',
    current_period_end: '2027-04-11T05:05:25Z',
    auto_renew: true,
    kwh_included: 20.0,
    kwh_used: 13.9023,
    kwh_remaining: 6.0977,
    in_overage: false,
  },
  key: { name: 'my-production-key', allowance: null },
};

describe('NeuralWatt quota provider', () => {
  it('builds subscription window from documented payload (keyed by plan name)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_SUBSCRIPTION_PAYLOAD)));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('neuralwatt');

    // Subscription window is keyed by the plan name; windowSeconds is null
    // because the API exposes no kWh window start to derive duration from.
    const window = result.usage.windows.standard;
    expect(window).toBeDefined();
    expect(window.usedPercent).toBeCloseTo((13.9023 / 20.0) * 100, 4);
    expect(window.windowSeconds).toBeNull();
    expect(window.resetAt).toBe(Date.parse('2027-04-11T05:05:25Z'));

    // allowance is null, so the credits_balance window is *also* surfaced.
    expect(result.usage.windows.credits_balance).toBeDefined();
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$32.68');
  });

  it('falls back to plan_limit title when plan is missing', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      subscription: { ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription, plan: null },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    expect(result.usage.windows.plan_limit).toBeDefined();
    expect(result.usage.windows.plan_limit.usedPercent).toBeCloseTo((13.9023 / 20.0) * 100, 4);
  });

  it('marks in-overage subscription as 100%, still shows credits', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      subscription: { ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription, in_overage: true, kwh_used: 25.0 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows.standard;
    expect(window).toBeDefined();
    expect(window.usedPercent).toBe(100);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$32.68');
  });

  it('surfaces subscription and allowance windows (allowance keyed by period, key name in valueLabel)', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      balance: { credits_remaining_usd: 200 },
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const subWindow = result.usage.windows.standard;
    expect(subWindow).toBeDefined();
    expect(subWindow.usedPercent).toBeCloseTo((13.9023 / 20.0) * 100, 4);

    // Allowance window is keyed by the localized period label ("monthly");
    // key name flows through valueLabel for identification.
    const allowWindow = result.usage.windows.monthly;
    expect(allowWindow).toBeDefined();
    expect(allowWindow.usedPercent).toBe(25);
    expect(allowWindow.valueLabel).toBe('Prod');
    expect(allowWindow.resetAt).toBe(Date.parse('2026-08-01T00:00:00Z'));

    // credits_balance suppressed because allowance is present
    expect(result.usage.windows.credits_balance).toBeUndefined();
  });

  it('uses allowance effective limit = min(limit, credits_remaining + spent)', async () => {
    const payload = {
      balance: { credits_remaining_usd: 30 },
      subscription: null,
      key: {
        name: 'prod-key',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows.monthly;
    expect(window).toBeDefined();
    // effectiveLimit = min(100, 30+25) = 55; usedPercent = 25/55 * 100 ≈ 45.4545
    expect(window.usedPercent).toBeCloseTo((25 / 55) * 100, 4);
    expect(window.windowSeconds).toBe(30 * 86400);
    expect(window.resetAt).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(window.valueLabel).toBe('prod-key');
    expect(result.usage.windows.credits_balance).toBeUndefined();
  });

  it('binds allowance ceiling to limit when limit < credits_remaining + spent', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'prod-key',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows.monthly;
    expect(window).toBeDefined();
    expect(window.usedPercent).toBe(25);
  });

  it('uses weekly as the allowance key when period is weekly', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'weekly', spent_usd: 20, blocked: false, reset_at: '2026-07-04T00:00:00Z' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows.weekly;
    expect(window).toBeDefined();
    expect(window.windowSeconds).toBe(604800);
    expect(window.resetAt).toBe(Date.parse('2026-07-04T00:00:00Z'));
    expect(window.valueLabel).toBe('Prod');
  });

  it('uses daily as the allowance key when period is daily', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'Prod',
        allowance: { limit_usd: 10, period: 'daily', spent_usd: 2, blocked: false, reset_at: '2026-07-04T00:00:00Z' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows.daily;
    expect(window).toBeDefined();
    expect(window.windowSeconds).toBe(86400);
    expect(window.resetAt).toBe(Date.parse('2026-07-04T00:00:00Z'));
  });

  it('falls back to billing_cycle when allowance period is missing or unknown', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'fortnightly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows.billing_cycle;
    expect(window).toBeDefined();
    expect(window.usedPercent).toBe(25);
  });

  it('marks blocked allowance as 100% with valueLabel set', async () => {
    const payload = {
      balance: { credits_remaining_usd: 30 },
      subscription: null,
      key: {
        name: 'sample',
        allowance: { limit_usd: 50, period: 'monthly', spent_usd: 10, blocked: true, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows.monthly;
    expect(window.usedPercent).toBe(100);
    expect(window.valueLabel).toBe('sample');
  });

  it('falls back to credits_balance when neither subscription nor allowance exists', async () => {
    const payload = {
      balance: { credits_remaining_usd: 32.6774 },
      subscription: null,
      key: { name: 'sample', allowance: null },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    expect(result.usage.windows.credits_balance.valueLabel).toBe('$32.68');
    expect(result.usage.windows.credits_balance.usedPercent).toBeNull();
  });

  it('maps 401 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with NeuralWatt');
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      balance: { credits_remaining_usd: null },
      subscription: null,
      key: { name: 'sample', allowance: null },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });
});
