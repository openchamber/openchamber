import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../credentials/store.js';
import * as fetchUtils from '../utils/fetch.js';
import * as stepfun from './stepfun.js';

// Sanitized canonical response shapes (fake token values, realistic numeric
// fields). Mirrors platform.stepfun.ai dashboard API contracts ported from
// mystatus/plugin/mystatus.ts:
//   POST /api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit (body `{}`)
//     -> StepFunRateLimitResponse
//   POST /api/step.openapi.devcenter.Dashboard/GetStepPlanStatus      (body `{}`)
//     -> StepFunPlanStatusResponse
//
// StepFunRateLimitResponse fields (verbatim from canonical types):
//   status, desc, five_hour_usage_left_rate, five_hour_usage_reset_time,
//   weekly_usage_left_rate, weekly_usage_reset_time
//
// StepFunPlanStatusResponse fields:
//   status, desc, subscription: { plan_type, name, status, pay_channel,
//     activated_at, expired_at, auto_renew, plan_id, source_channel_code },
//   plan_definition: { type, price, duration_days, support_models[],
//     available, original_price, plan_id, billing_cycle },
//   can_resign
//
// Rates are fractional remaining (1 = full, 0.5 = half left). Reset times
// are epoch-second strings.

const OASIS_TOKEN = 'fake-oasis-token';
const OASIS_WEBID = 'fake-webid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION_TOKEN = 'fake-session-token';

// five_hour_usage_left_rate = 0.75 -> remaining 75%, usedPercent 25%.
// weekly_usage_left_rate    = 0.40 -> remaining 40%, usedPercent 60%.
const RATE_LIMIT_RESPONSE = {
  status: 1,
  desc: 'ok',
  five_hour_usage_left_rate: 0.75,
  five_hour_usage_reset_time: '1750000000', // epoch sec
  weekly_usage_left_rate: 0.4,
  weekly_usage_reset_time: '1750500000', // epoch sec
};

const PLAN_STATUS_RESPONSE = {
  status: 1,
  desc: 'ok',
  subscription: {
    plan_type: 1,
    name: 'StepFun Pro',
    status: 1,
    pay_channel: 0,
    activated_at: '1740000000',
    expired_at: '1760000000', // epoch sec
    auto_renew: true,
    plan_id: 'fake-plan-id',
    source_channel_code: '',
  },
  plan_definition: {
    type: 1,
    price: '19900', // cents -> $199.00/mo
    duration_days: 30,
    support_models: ['step-2-16k', 'step-2-mini'],
    available: true,
    original_price: '29900',
    plan_id: 'fake-plan-id',
    billing_cycle: 1,
  },
  can_resign: true,
};

describe('stepfun quota provider', () => {
  let getCredentialSpy;
  let fetchSpy;

  beforeEach(() => {
    getCredentialSpy = vi.spyOn(store, 'getCredential');
    fetchSpy = vi.spyOn(fetchUtils, 'fetchWithRetry');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when no credentials', () => {
    getCredentialSpy.mockReturnValue(undefined);
    expect(stepfun.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when oasisToken and oasisWebid exist', () => {
    getCredentialSpy.mockReturnValue({
      credential: { oasisToken: OASIS_TOKEN, oasisWebid: OASIS_WEBID },
    });
    expect(stepfun.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when oasisToken missing', () => {
    getCredentialSpy.mockReturnValue({ credential: { oasisWebid: OASIS_WEBID } });
    expect(stepfun.isConfigured()).toBe(false);
  });

  it('isConfigured returns false when oasisWebid missing', () => {
    getCredentialSpy.mockReturnValue({ credential: { oasisToken: OASIS_TOKEN } });
    expect(stepfun.isConfigured()).toBe(false);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    getCredentialSpy.mockReturnValue(undefined);
    const result = await stepfun.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('fetchQuota returns configured:false when oasisWebid missing', async () => {
    getCredentialSpy.mockReturnValue({ credential: { oasisToken: OASIS_TOKEN } });
    const result = await stepfun.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('transforms canonical QueryStepPlanRateLimit + GetStepPlanStatus into correct windows/header', async () => {
    getCredentialSpy.mockReturnValue({
      credential: {
        oasisToken: OASIS_TOKEN,
        oasisWebid: OASIS_WEBID,
        sessionToken: SESSION_TOKEN,
      },
    });
    // QueryStepPlanRateLimit (POST), GetStepPlanStatus (POST) in call order.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => RATE_LIMIT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => PLAN_STATUS_RESPONSE });

    const result = await stepfun.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Two canonical endpoints called in order, both POST with body `{}`.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calls = fetchSpy.mock.calls;
    expect(calls[0][0]).toBe(
      'https://platform.stepfun.ai/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit',
    );
    expect(calls[0][1].method).toBe('POST');
    expect(calls[0][1].body).toBe('{}');
    expect(calls[1][0]).toBe(
      'https://platform.stepfun.ai/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus',
    );
    expect(calls[1][1].method).toBe('POST');
    expect(calls[1][1].body).toBe('{}');

    // Canonical headers on every call.
    for (const [, opts] of calls) {
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['oasis-appid']).toBe('20700');
      expect(opts.headers['oasis-platform']).toBe('web');
      expect(opts.headers['oasis-webid']).toBe(OASIS_WEBID);
      expect(opts.headers.Origin).toBe('https://platform.stepfun.ai');
      expect(opts.headers.Referer).toBe('https://platform.stepfun.ai/plan-usage');
      expect(opts.headers['User-Agent']).toBe('OpenCode-AllStatus/1.0');
      expect(opts.headers.Accept).toBe('application/json');
      // Cookie carries Oasis-Token + Oasis-Webid + session token.
      expect(opts.headers.Cookie).toContain(`Oasis-Token=${OASIS_TOKEN}`);
      expect(opts.headers.Cookie).toContain(`Oasis-Webid=${OASIS_WEBID}`);
      expect(opts.headers.Cookie).toContain(
        `__Secure-next-auth.session-token=${SESSION_TOKEN}`,
      );
    }

    const windows = result.usage.windows;
    expect(Object.keys(windows).sort()).toEqual(['5h', 'weekly']);

    // 5h: left_rate 0.75 -> remaining 75, usedPercent 25.
    const fiveHour = windows['5h'];
    expect(fiveHour.usedPercent).toBe(25);
    expect(fiveHour.remainingPercent).toBe(75);
    expect(fiveHour.windowSeconds).toBe(5 * 3600);
    // resetAt from epoch-sec string -> ISO.
    expect(typeof fiveHour.resetAt).toBe('string');
    expect(new Date(fiveHour.resetAt).getTime()).toBe(1750000000 * 1000);

    // weekly: left_rate 0.40 -> remaining 40, usedPercent 60.
    const weekly = windows.weekly;
    expect(weekly.usedPercent).toBe(60);
    expect(weekly.remainingPercent).toBe(40);
    expect(weekly.windowSeconds).toBe(7 * 86400);
    expect(new Date(weekly.resetAt).getTime()).toBe(1750500000 * 1000);

    // Header carries plan name + renewal/expiry + price (canonical plan-status).
    expect(Array.isArray(result.usage.header)).toBe(true);
    expect(result.usage.header.some((l) => l.includes('StepFun Pro'))).toBe(true);
    // auto_renew=true -> "Renews:" line with the expired_at-derived date.
    expect(result.usage.header.some((l) => /Renews:/.test(l))).toBe(true);
    // price 19900 cents -> $199.00/mo.
    expect(result.usage.header.some((l) => l.includes('$199.00'))).toBe(true);

    // Footer carries supported models from plan_definition.
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('step-2-16k'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('step-2-mini'))).toBe(true);
  });

  it('uses Expires: instead of Renews: when auto_renew is false', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { oasisToken: OASIS_TOKEN, oasisWebid: OASIS_WEBID },
    });
    const noRenew = {
      ...PLAN_STATUS_RESPONSE,
      subscription: { ...PLAN_STATUS_RESPONSE.subscription, auto_renew: false },
    };
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => RATE_LIMIT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => noRenew });

    const result = await stepfun.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.header.some((l) => /Expires:/.test(l))).toBe(true);
    expect(result.usage.header.some((l) => /Renews:/.test(l))).toBe(false);
  });

  it('omits session-token cookie when sessionToken not configured', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { oasisToken: OASIS_TOKEN, oasisWebid: OASIS_WEBID },
    });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => RATE_LIMIT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => PLAN_STATUS_RESPONSE });

    await stepfun.fetchQuota();
    const calls = fetchSpy.mock.calls;
    for (const [, opts] of calls) {
      expect(opts.headers.Cookie).not.toContain('__Secure-next-auth.session-token');
    }
  });

  it('returns ok:false (no stale fallback) when QueryStepPlanRateLimit returns 401', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { oasisToken: OASIS_TOKEN, oasisWebid: OASIS_WEBID },
    });
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await stepfun.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('falls back to stale cached result on transient failure after a prior success', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { oasisToken: OASIS_TOKEN, oasisWebid: OASIS_WEBID },
    });
    // First call: success.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => RATE_LIMIT_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => PLAN_STATUS_RESPONSE });
    const first = await stepfun.fetchQuota();
    expect(first.ok).toBe(true);

    // Second call: QueryStepPlanRateLimit throws (network/retry exhausted).
    fetchSpy.mockRejectedValueOnce(new Error('Network request failed'));
    const second = await stepfun.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
  });

  it('handles missing rate-limit data gracefully (plan-status only)', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { oasisToken: OASIS_TOKEN, oasisWebid: OASIS_WEBID },
    });
    // Rate-limit returns status != 1 (no data); plan-status ok.
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 0, desc: 'no data' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => PLAN_STATUS_RESPONSE });

    const result = await stepfun.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows).toEqual({});
    // Header still carries plan info.
    expect(result.usage.header.some((l) => l.includes('StepFun Pro'))).toBe(true);
  });

  it('handles missing plan-status data gracefully (rate-limit only)', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { oasisToken: OASIS_TOKEN, oasisWebid: OASIS_WEBID },
    });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => RATE_LIMIT_RESPONSE })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 0, desc: 'no data' }),
      });

    const result = await stepfun.fetchQuota();
    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows).sort()).toEqual(['5h', 'weekly']);
    // No plan header when plan-status absent.
    expect(result.usage.header).toBeUndefined();
    expect(result.usage.footer).toBeUndefined();
  });

  it('returns ok:false when both endpoints return no data', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { oasisToken: OASIS_TOKEN, oasisWebid: OASIS_WEBID },
    });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 0, desc: 'no data' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 0, desc: 'no data' }) });

    const result = await stepfun.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
  });
});