import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchQuota } from './cursor.js';

const futureToken = () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `header.${payload}.signature`;
};

const mockResponses = (routes) => {
  const fetchMock = vi.fn(async (url) => {
    const match = Object.entries(routes).find(([fragment]) => String(url).includes(fragment));
    if (!match) throw new Error(`Unexpected fetch: ${url}`);
    const { status = 200, body = {} } = match[1];
    return { ok: status < 400, status, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const ok = (body) => ({ status: 200, body });
const notFound = () => ({ status: 404 });

const enterpriseRoutes = {
  GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088', billingCycleEnd: '1787932328088', displayThreshold: 100 }),
  GetPlanInfo: ok({ planInfo: { planName: 'Enterprise', price: 'Custom', billingCycleEnd: '1788220800000' } }),
  GetCreditGrantsBalance: ok({}),
  full_stripe_profile: ok({ teamId: 424242, isTeamMember: true, membershipType: 'enterprise' }),
  'auth/usage': ok({ 'gpt-4': { numRequests: 590, maxRequestUsage: 1000 } }),
  GetHardLimit: ok({ hardLimit: 12500, hardLimitPerUser: 250 }),
  GetTeamSpend: ok({ teamMemberSpend: [] }),
  GetMe: ok({ userId: 424242, email: 'me@example.com', teamId: 424242, isEnterpriseUser: true })
};

beforeEach(() => {
  process.env.CURSOR_TOKEN = futureToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CURSOR_TOKEN;
});

describe('Cursor quota', () => {
  it('keeps the planUsage path for Pro accounts', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: true, planUsage: { totalPercentUsed: 42, totalSpend: 2300 } }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerName).toBe('Cursor Pro');
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(42);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('$23.00');
  });

  it('falls back to auth/usage and team-scoped GetHardLimit for enterprise accounts', async () => {
    const fetchMock = mockResponses(enterpriseRoutes);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerName).toBe('Cursor Enterprise');
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('590 / 1000');
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(59);
    expect(result.usage.windows.on_demand).toBeUndefined();
    const hardLimitCall = fetchMock.mock.calls.find(([url]) => String(url).includes('GetHardLimit'));
    expect(JSON.parse(hardLimitCall[1].body)).toEqual({ teamId: '424242' });
  });

  it('picks the largest request bucket and skips metadata', async () => {
    mockResponses({
      ...enterpriseRoutes,
      'auth/usage': ok({
        startOfMonth: '2026-08-01',
        'gpt-4o': { numRequests: 120, maxRequestUsage: 500 },
        'gpt-4': { numRequests: 829, maxRequestUsage: 1000 }
      })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('829 / 1000');
  });

  it('reports on-demand spend from GetTeamSpend for enterprise accounts', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetTeamSpend: ok({
        teamMemberSpend: [
          { userId: 999999, spendCents: 100 },
          { userId: 424242, spendCents: 672 }
        ]
      })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.on_demand.valueLabel).toBe('$6.72 / $250.00');
    expect(result.usage.windows.on_demand.usedPercent).toBeCloseTo(2.688, 3);
  });

  it('does not report success from plan name alone', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088' }),
      GetPlanInfo: ok({ planInfo: { planName: 'Enterprise', billingCycleEnd: '1788220800000' } }),
      GetCreditGrantsBalance: notFound(),
      full_stripe_profile: ok({ teamId: 424242, isTeamMember: true }),
      'auth/usage': notFound(),
      GetHardLimit: notFound(),
      GetTeamSpend: notFound(),
      GetMe: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });

  it('omits the on-demand window when spend cannot be verified', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetTeamSpend: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('590 / 1000');
    expect(result.usage.windows.on_demand).toBeUndefined();
  });

  it('reports a disabled subscription as an error', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: false }),
      GetPlanInfo: notFound(),
      GetCreditGrantsBalance: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });

  it('still errors when an enterprise fallback finds no usable data', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088' }),
      GetPlanInfo: notFound(),
      GetCreditGrantsBalance: notFound(),
      full_stripe_profile: notFound(),
      'auth/usage': notFound(),
      GetHardLimit: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });
});
