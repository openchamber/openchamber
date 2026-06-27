import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../credentials/store.js';
import * as fetchUtils from '../utils/fetch.js';
import * as atlascloud from './atlascloud.js';

// Sanitized canonical response shapes (fake token values, realistic numeric
// fields). Mirrors console.atlascloud.ai API contracts ported from
// mystatus/plugin/mystatus.ts:
//   GET  /api/v1/current-user   -> { code, data: { userId, name, email, currentAccountUuid, currentAccountName } }
//   POST /api/v1/codeplan/get   -> { code, data: AtlasCodePlanSubscription[], message? }
//   GET  /api/v1/codeplan/costs -> { code, data: { total, pageNo, pageSize, items: AtlasCodePlanCostItem[] }, message? }
//
// AtlasCodePlanSubscription fields (verbatim from canonical types):
//   SubscriptionID, AccountID, PlanID, PlanName, plan_uuid, PlanType, Price,
//   DailyQuota, PackageQuota, balance, StartedAt, ExpiredAt, CreatedAt,
//   ValidDays, Status, AutoRenewal
//
// AtlasCodePlanCostItem fields:
//   finishTime, chatId, model, modelCost, planId, amount, remain,
//   usage?: { input?, output?, cache?, amount? }, apikeyName?

const COOKIE = 'access-token=fake.jwt.payload; other=fake';

const CURRENT_USER_RESPONSE = {
  code: '0',
  data: {
    userId: 'fake-user-1',
    name: 'Jane Doe',
    email: 'jane@example.com',
    currentAccountUuid: 'fake-account-uuid',
    currentAccountName: 'Personal',
  },
};

// Active subscription: DailyQuota=1000, balance=750 -> remaining 75%,
// usedPercent 25%. ExpiredAt far in the future (ms).
const CODEPLAN_GET_RESPONSE = {
  code: '0',
  data: [
    {
      SubscriptionID: 1001,
      AccountID: 2002,
      PlanID: 3003,
      PlanName: 'Pro',
      plan_uuid: 'fake-plan-uuid',
      PlanType: 'monthly',
      Price: '20',
      DailyQuota: '1000',
      PackageQuota: null,
      balance: '750',
      StartedAt: 1700000000,
      ExpiredAt: 1800000000000,
      CreatedAt: 1700000000,
      ValidDays: null,
      Status: 'Active',
      AutoRenewal: true,
    },
  ],
  message: 'ok',
};

const COSTS_RESPONSE = {
  code: '0',
  data: {
    total: 2,
    pageNo: 1,
    pageSize: 5,
    items: [
      {
        finishTime: 1750000000000,
        chatId: 'fake-chat-1',
        model: 'glm-4.6',
        modelCost: '10',
        planId: '3003',
        amount: '10',
        remain: '740',
        usage: { input: 1200, output: 300, cache: 0, amount: '10' },
        apikeyName: 'default',
      },
      {
        finishTime: 1750000100000,
        chatId: 'fake-chat-2',
        model: 'glm-4.6-air',
        modelCost: '5',
        planId: '3003',
        amount: '5',
        remain: '745',
        usage: { input: 600, output: 150, amount: '5' },
      },
    ],
  },
  message: 'ok',
};

describe('atlascloud quota provider', () => {
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
    expect(atlascloud.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when cookie contains access-token=', () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    expect(atlascloud.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when cookie lacks access-token=', () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'other=fake' } });
    expect(atlascloud.isConfigured()).toBe(false);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    getCredentialSpy.mockReturnValue(undefined);
    const result = await atlascloud.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('fetchQuota returns configured:false when cookie lacks access-token=', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: 'other=fake' } });
    const result = await atlascloud.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('transforms canonical current-user + codeplan/get + costs into correct windows/footer', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    // current-user (GET), codeplan/get (POST), costs (GET) in call order.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => CURRENT_USER_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => CODEPLAN_GET_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => COSTS_RESPONSE });

    const result = await atlascloud.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Three canonical endpoints called in order.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const calls = fetchSpy.mock.calls;
    expect(calls[0][0]).toBe('https://console.atlascloud.ai/api/v1/current-user');
    expect(calls[0][1].method).toBeUndefined(); // GET
    expect(calls[1][0]).toBe('https://console.atlascloud.ai/api/v1/codeplan/get');
    expect(calls[1][1].method).toBe('POST');
    expect(calls[1][1].body).toBe(''); // canonical empty body
    expect(calls[2][0].startsWith('https://console.atlascloud.ai/api/v1/codeplan/costs?')).toBe(true);

    // Canonical headers on every call.
    for (const [, opts] of calls) {
      expect(opts.headers.Cookie).toBe(COOKIE);
      expect(opts.headers['User-Agent']).toMatch(/Firefox/);
      expect(opts.headers.Origin).toBe('https://www.atlascloud.ai');
      expect(opts.headers.Referer).toBe('https://www.atlascloud.ai/');
      expect(opts.headers['Content-Type']).toBe('application/json');
    }
    // accountUuid resolved from current-user -> sent as X-Account-ID on plan + costs.
    expect(calls[1][1].headers['X-Account-ID']).toBe('fake-account-uuid');
    expect(calls[2][1].headers['X-Account-ID']).toBe('fake-account-uuid');

    const windows = result.usage.windows;
    expect(Object.keys(windows).sort()).toEqual(['1d']);

    const daily = windows['1d'];
    // balance=750, DailyQuota=1000 -> remaining 75%, usedPercent 25.
    expect(daily.usedPercent).toBe(25);
    expect(daily.remainingPercent).toBe(75);
    // resetAt = next UTC midnight (ISO string).
    expect(typeof daily.resetAt).toBe('string');
    const resetDate = new Date(daily.resetAt);
    expect(resetDate.getUTCHours()).toBe(0);
    expect(resetDate.getUTCMinutes()).toBe(0);
    expect(resetDate.getUTCSeconds()).toBe(0);
    expect(resetDate.getUTCMilliseconds()).toBe(0);
    // valueLabel carries the plan name.
    expect(daily.valueLabel).toBe('Pro');
    // detail carries the "Used today: X / Y" line from canonical.
    expect(Array.isArray(daily.detail)).toBe(true);
    expect(daily.detail.some((l) => l.includes('250') && l.includes('1,000'))).toBe(true);

    // Footer: subscription expiry + recent costs block.
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Subscription expires'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Recent calls'))).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('glm-4.6'))).toBe(true);
  });

  it('uses configured accountUuid when current-user omits it', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { cookie: COOKIE, accountUuid: 'configured-uuid' },
    });
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: '0',
          data: { userId: 'u', name: 'n', email: 'e', currentAccountName: 'Personal' },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => CODEPLAN_GET_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => COSTS_RESPONSE });

    const result = await atlascloud.fetchQuota();
    expect(result.ok).toBe(true);
    const calls = fetchSpy.mock.calls;
    expect(calls[1][1].headers['X-Account-ID']).toBe('configured-uuid');
    expect(calls[2][1].headers['X-Account-ID']).toBe('configured-uuid');
  });

  it('returns ok:false (no stale fallback) when codeplan/get returns 401', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => CURRENT_USER_RESPONSE })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await atlascloud.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
  });

  it('falls back to stale cached result on transient failure after a prior success', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    // First call: success.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => CURRENT_USER_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => CODEPLAN_GET_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => COSTS_RESPONSE });
    const first = await atlascloud.fetchQuota();
    expect(first.ok).toBe(true);

    // Second call: current-user ok, codeplan/get throws (network/retry exhausted).
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => CURRENT_USER_RESPONSE })
      .mockRejectedValueOnce(new Error('Network request failed'));
    const second = await atlascloud.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
  });

  it('handles no active subscription gracefully', async () => {
    getCredentialSpy.mockReturnValue({ credential: { cookie: COOKIE } });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => CURRENT_USER_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: '0', data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: '0', data: { total: 0, pageNo: 1, pageSize: 5, items: [] } }) });

    const result = await atlascloud.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.windows).toEqual({});
    // Footer still present (subscription expiry line for the no-sub case is absent,
    // but the recent-calls block is also absent when items empty).
    expect(result.usage.footer).toBeUndefined();
  });
});