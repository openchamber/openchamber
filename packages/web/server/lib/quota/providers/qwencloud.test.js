import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../credentials/store.js';
import * as fetchUtils from '../utils/fetch.js';
import * as qwencloud from './qwencloud.js';

// Sanitized canonical response shapes (fake ticket values, realistic
// numeric fields). Mirrors home.qwencloud.com dashboard API contracts
// ported from mystatus/plugin/mystatus.ts:
//   GET  https://home.qwencloud.com/  (extract SEC_TOKEN from inline JS)
//   POST https://home.qwencloud.com/data/api.json?product=BssOpenAPI-V3
//        &action=GetSeatSubscriptionSummary
//        body: URLSearchParams({ product, action, sec_token, region,
//                               params: JSON.stringify({ productCode }) })
//     -> QwenCloudSubSummaryResponse { code, data: { Data } }
//   POST https://home.qwencloud.com/data/api.json?product=BssOpenApi
//        &action=CheckTokenPlanAutoRenewal
//        body: URLSearchParams({ CommodityCode })
//     -> QwenCloudRenewalResponse { Success, Data: { AutoRenewal } }
//
// QwenCloudSubSummaryResponse.data.Data fields (verbatim from canonical):
//   EndTime, StartTime, RemainingDays, SubscriptionGroupList: [{
//     SpecType, SubscriptionTotalNumber,
//     EquityList: [{ EquityCode, TotalValue, SurplusValue, EquityType }],
//     NextCycleFlushTime }]
//
// Auth shape (from credentials/schemas.js qwencloud):
//   ticket (required), aliyunPk (required), isg (required), esmTicket (optional)

const TICKET = 'fake-qwencloud-ticket';
const ALIYUN_PK = 'fake-aliyun-pk';
const ISG = 'fake-isg-value';
const ESM_TICKET = 'fake-esm-ticket';
const SEC_TOKEN = 'fake-sec-token-abcdef';

// Total=10000, Surplus=7500 -> used 2500, remainingPct 75, usedPercent 25.
// RemainingDays=15 -> valueLabel 'Credits (15d remaining)'.
// SubscriptionTotalNumber=2, SpecType='standard' -> sectionHeader contains
// 'Token Plan Team Edition (standard, 2 seats)'.
// NextCycleFlushTime -> resetAt ISO.
const SUB_SUMMARY_RESPONSE = {
  code: '200',
  data: {
    Data: {
      EndTime: '2025-12-31T23:59:59Z',
      StartTime: '2025-12-01T00:00:00Z',
      RemainingDays: 15,
      SubscriptionGroupList: [
        {
          SpecType: 'standard',
          SubscriptionTotalNumber: 2,
          EquityList: [
            {
              EquityCode: 'credits',
              TotalValue: 10000,
              SurplusValue: 7500,
              EquityType: 'CREDITS',
            },
          ],
          NextCycleFlushTime: '2025-12-31T23:59:59Z',
        },
      ],
    },
  },
};

const RENEWAL_RESPONSE = {
  code: '200',
  data: { Success: true, Data: { AutoRenewal: 1 } },
};

// Canonical homepage inline JS shape: `SEC_TOKEN: "..."` (colon, not equals).
const HOMEPAGE_HTML = `<script>window.config = { SEC_TOKEN: "${SEC_TOKEN}" };</script>`;

describe('qwencloud quota provider', () => {
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
    expect(qwencloud.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when ticket, aliyunPk, and isg exist', () => {
    getCredentialSpy.mockReturnValue({
      credential: { ticket: TICKET, aliyunPk: ALIYUN_PK, isg: ISG },
    });
    expect(qwencloud.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when ticket missing', () => {
    getCredentialSpy.mockReturnValue({ credential: { aliyunPk: ALIYUN_PK, isg: ISG } });
    expect(qwencloud.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when aliyunPk missing (optional for intl accounts)', () => {
    getCredentialSpy.mockReturnValue({ credential: { ticket: TICKET, isg: ISG } });
    expect(qwencloud.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when isg missing', () => {
    getCredentialSpy.mockReturnValue({ credential: { ticket: TICKET, aliyunPk: ALIYUN_PK } });
    expect(qwencloud.isConfigured()).toBe(false);
  });

  it('fetchQuota returns configured:false when not configured', async () => {
    getCredentialSpy.mockReturnValue(undefined);
    const result = await qwencloud.fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('transforms canonical GetSeatSubscriptionSummary + CheckTokenPlanAutoRenewal into correct windows/footer', async () => {
    getCredentialSpy.mockReturnValue({
      credential: {
        ticket: TICKET,
        aliyunPk: ALIYUN_PK,
        isg: ISG,
        esmTicket: ESM_TICKET,
      },
    });
    // Three calls in order: homepage GET, sub POST, renewal POST.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => HOMEPAGE_HTML })
      .mockResolvedValueOnce({ ok: true, json: async () => SUB_SUMMARY_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => RENEWAL_RESPONSE });

    const result = await qwencloud.fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage).not.toBeNull();

    // Three canonical endpoints called in order.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const calls = fetchSpy.mock.calls;

    // 1. Homepage GET to extract SEC_TOKEN.
    expect(calls[0][0]).toBe('https://home.qwencloud.com/');
    expect(calls[0][1].method).toBe('GET');

    // 2. Subscription summary POST.
    expect(calls[1][0]).toBe(
      'https://home.qwencloud.com/data/api.json?product=BssOpenAPI-V3&action=GetSeatSubscriptionSummary',
    );
    expect(calls[1][1].method).toBe('POST');

    // 3. Auto-renewal check POST.
    expect(calls[2][0]).toBe(
      'https://home.qwencloud.com/data/api.json?product=BssOpenApi&action=CheckTokenPlanAutoRenewal',
    );
    expect(calls[2][1].method).toBe('POST');

    // Canonical headers on every call.
    for (const [, opts] of calls) {
      const headers = opts.headers;
      expect(headers['bx-v']).toBe('2.5.36');
      expect(headers.Referer).toBe('https://home.qwencloud.com/');
      expect(headers.Origin).toBe('https://home.qwencloud.com');
      expect(headers['User-Agent']).toBe('OpenCode-AllStatus/1.0');
      expect(headers.Accept).toBe('application/json, text/plain, */*');
      // Cookie carries ticket + aliyunPk + isg + esmTicket.
      expect(headers.Cookie).toContain(`login_qwencloud_ticket=${TICKET}`);
      expect(headers.Cookie).toContain(`login_aliyunid_pk=${ALIYUN_PK}`);
      expect(headers.Cookie).toContain(`isg=${ISG}`);
      expect(headers.Cookie).toContain(`login_ESM_account_ticket=${ESM_TICKET}`);
    }

    // Homepage GET must NOT carry Content-Type (canonical deletes it).
    expect(calls[0][1].headers['Content-Type']).toBeUndefined();

    // Sub + renewal POSTs carry form-urlencoded Content-Type.
    expect(calls[1][1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[2][1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    // Sub body is URLSearchParams containing sec_token + params + region.
    const subBody = calls[1][1].body;
    expect(subBody).toBeInstanceOf(URLSearchParams);
    expect(subBody.get('product')).toBe('BssOpenAPI-V3');
    expect(subBody.get('action')).toBe('GetSeatSubscriptionSummary');
    expect(subBody.get('sec_token')).toBe(SEC_TOKEN);
    expect(subBody.get('region')).toBe('cn-hangzhou');
    const subParams = JSON.parse(subBody.get('params'));
    expect(subParams.productCode).toBe('sfm_tokenplanteams_dp_intl');

    // Renewal body carries product/action/sec_token/region + params{CommodityCode}.
    const renewalBody = calls[2][1].body;
    expect(renewalBody).toBeInstanceOf(URLSearchParams);
    expect(renewalBody.get('action')).toBe('CheckTokenPlanAutoRenewal');
    expect(renewalBody.get('sec_token')).toBe(SEC_TOKEN);
    expect(renewalBody.get('region')).toBe('cn-hangzhou');
    const renewalParams = JSON.parse(renewalBody.get('params'));
    expect(renewalParams.CommodityCode).toBe('sfm_tokenplanteams_dp_intl');

    // Transform: Total=10000, Surplus=7500 -> used 2500, remainingPct 75.
    const windows = result.usage.windows;
    expect(Object.keys(windows)).toEqual(['credits']);
    const credits = windows.credits;
    expect(credits.usedPercent).toBe(25);
    expect(credits.remainingPercent).toBe(75);
    // valueLabel carries RemainingDays.
    expect(credits.valueLabel).toBe('Credits (15d remaining)');
    // detail contains formatted used/total with thousands separators.
    expect(Array.isArray(credits.detail)).toBe(true);
    expect(credits.detail.some((l) => l.includes('2,500'))).toBe(true);
    expect(credits.detail.some((l) => l.includes('10,000'))).toBe(true);
    // sectionHeader carries plan + spec + seats + auto-renewal.
    expect(credits.sectionHeader).toContain('Token Plan Team Edition');
    expect(credits.sectionHeader).toContain('standard');
    expect(credits.sectionHeader).toContain('2 seats');
    expect(credits.sectionHeader).toContain('auto-renewal: enabled');
    // resetAt is the ISO of NextCycleFlushTime.
    expect(credits.resetAt).toBe(new Date('2025-12-31T23:59:59Z').toISOString());

    // Footer carries the cycle line.
    expect(Array.isArray(result.usage.footer)).toBe(true);
    expect(result.usage.footer.some((l) => l.includes('Cycle:'))).toBe(true);
  });

  it('omits esmTicket cookie when not configured', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { ticket: TICKET, aliyunPk: ALIYUN_PK, isg: ISG },
    });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => HOMEPAGE_HTML })
      .mockResolvedValueOnce({ ok: true, json: async () => SUB_SUMMARY_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => RENEWAL_RESPONSE });

    await qwencloud.fetchQuota();
    const calls = fetchSpy.mock.calls;
    for (const [, opts] of calls) {
      expect(opts.headers.Cookie).not.toContain('login_ESM_account_ticket');
    }
  });

  it('returns ok:false no isStale when SEC_TOKEN cannot be extracted', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { ticket: TICKET, aliyunPk: ALIYUN_PK, isg: ISG },
    });
    // Homepage returns ok but no SEC_TOKEN in HTML.
    fetchSpy.mockResolvedValueOnce({ ok: true, text: async () => '<html>no token here</html>' });

    const result = await qwencloud.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
    expect(result.error).toContain('SEC_TOKEN');
  });

  it('returns ok:false no isStale when homepage returns non-ok status', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { ticket: TICKET, aliyunPk: ALIYUN_PK, isg: ISG },
    });
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' });

    const result = await qwencloud.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
    expect(result.error).toContain('Homepage API error');
  });

  it('returns ok:false no isStale when sub endpoint returns 401', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { ticket: TICKET, aliyunPk: ALIYUN_PK, isg: ISG },
    });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => HOMEPAGE_HTML })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => RENEWAL_RESPONSE });

    const result = await qwencloud.fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.isStale).toBeUndefined();
    expect(result.error).toContain('API error');
  });

  it('returns ok:true with no-subscription placeholder when subData has no Data', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { ticket: TICKET, aliyunPk: ALIYUN_PK, isg: ISG },
    });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => HOMEPAGE_HTML })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: '200', data: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => RENEWAL_RESPONSE });

    const result = await qwencloud.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows).toEqual({});
    expect(result.usage.footer).toEqual(['QwenCloud: no active subscription']);
  });

  it('falls back to stale cached result on transient failure after a prior success', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { ticket: TICKET, aliyunPk: ALIYUN_PK, isg: ISG },
    });
    // First call: success.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => HOMEPAGE_HTML })
      .mockResolvedValueOnce({ ok: true, json: async () => SUB_SUMMARY_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => RENEWAL_RESPONSE });
    const first = await qwencloud.fetchQuota();
    expect(first.ok).toBe(true);

    // Second call: homepage throws (network/retry exhausted).
    fetchSpy.mockRejectedValueOnce(new Error('Network request failed'));
    const second = await qwencloud.fetchQuota();
    expect(second.ok).toBe(true);
    expect(second.isStale).toBe(true);
  });

  it('tolerates renewal fetch failure (best-effort) without rejecting', async () => {
    getCredentialSpy.mockReturnValue({
      credential: { ticket: TICKET, aliyunPk: ALIYUN_PK, isg: ISG },
    });
    fetchSpy
      .mockResolvedValueOnce({ ok: true, text: async () => HOMEPAGE_HTML })
      .mockResolvedValueOnce({ ok: true, json: async () => SUB_SUMMARY_RESPONSE })
      .mockRejectedValueOnce(new Error('Network request failed'));

    const result = await qwencloud.fetchQuota();
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    // autoRenewal is null because renewal failed -> sectionHeader omits auto-renewal.
    expect(result.usage.windows.credits.sectionHeader).not.toContain('auto-renewal');
  });
});