/**
 * QwenCloud quota provider
 *
 * Ticket-based manual-auth provider for the QwenCloud Token Plan Team
 * Edition. Credentials are stored via the credential registry
 * (`getCredential`) and API calls go through `fetchWithRetry` for timeout,
 * retry, and backoff handling.
 *
 * Canonical API (ported from home.qwencloud.com dashboard, source of
 * truth: mystatus/plugin/mystatus.ts):
 *   GET  https://home.qwencloud.com/
 *        -> HTML; extract SEC_TOKEN via /SEC_TOKEN:\s*"([^"]+)"/
 *   POST https://home.qwencloud.com/data/api.json?product=BssOpenAPI-V3
 *        &action=GetSeatSubscriptionSummary
 *        body: URLSearchParams({ product, action, sec_token, region,
 *                               params: JSON.stringify({ productCode }) })
 *     -> QwenCloudSubSummaryResponse { code, data: { Data } }
 *   POST https://home.qwencloud.com/data/api.json?product=BssOpenApi
 *        &action=CheckTokenPlanAutoRenewal
 *        body: URLSearchParams({ CommodityCode })
 *     -> QwenCloudRenewalResponse { Success, Data: { AutoRenewal } }
 *
 * Auth shape (from credentials/schemas.js qwencloud):
 *   - `ticket`    (required): sent as `login_qwencloud_ticket` cookie
 *   - `isg`       (required): sent as `isg` cookie
 *   - `esmTicket` (optional): sent as `login_ESM_account_ticket` cookie
 *   - `aliyunPk`  (optional): sent as `login_aliyunid_pk` cookie when present
 *
 * Region is `cn-hangzhou` and `aliyunPk` is optional — both verified against
 * live home.qwencloud.com traffic for the international Token Plan.
 *
 * The subscription + renewal POSTs run in parallel; renewal is
 * best-effort (its failure does NOT reject the overall fetch). On
 * retryable failures (429/5xx after retry exhaustion, network errors,
 * timeouts) of the homepage or subscription fetch, the provider falls
 * back to the last successful result marked `isStale: true`. Auth
 * failures (401/403) and parse errors do NOT trigger cache fallback —
 * a stale snapshot cannot confirm whether the credential is still
 * valid.
 *
 * Tickets and cookies are never included in error messages.
 *
 * @module quota/providers/qwencloud
 */

import { getCredential } from '../credentials/store.js';
import {
  fetchWithRetry,
  buildResult,
  toUsageWindow,
  toTimestamp,
} from '../utils/index.js';

export const providerId = 'qwencloud';
export const providerName = 'QwenCloud';

const QWENCLOUD_BASE = 'https://home.qwencloud.com';
const QWENCLOUD_BX_V = '2.5.36';
const QWENCLOUD_USER_AGENT = 'OpenCode-AllStatus/1.0';

const HOMEPAGE_URL = `${QWENCLOUD_BASE}/`;
const SUB_SUMMARY_URL = `${QWENCLOUD_BASE}/data/api.json?product=BssOpenAPI-V3&action=GetSeatSubscriptionSummary`;
const RENEWAL_URL = `${QWENCLOUD_BASE}/data/api.json?product=BssOpenApi&action=CheckTokenPlanAutoRenewal`;
const PRODUCT_CODE = 'sfm_tokenplanteams_dp_intl';
const REGION = 'cn-hangzhou';

const SEC_TOKEN_REGEX = /SEC_TOKEN:\s*"([^"]+)"/;

/**
 * In-memory cache of the last successful result, keyed by accountHint.
 * Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Resolve the ticket, isg, and optional aliyunPk/esmTicket from the
 * credential store. Only ticket and isg are required; aliyunPk
 * (login_aliyunid_pk) is optional and absent for international accounts.
 *
 * @returns {{ ticket: string|null, aliyunPk?: string, isg: string|null, esmTicket?: string, accountKey: string|null }}
 */
function resolveCredential() {
  const record = getCredential(providerId);
  if (!record?.credential) {
    return { ticket: null, aliyunPk: null, isg: null, accountKey: null };
  }
  const credential = record.credential;
  const ticket =
    typeof credential.ticket === 'string' && credential.ticket.length > 0
      ? credential.ticket
      : null;
  const aliyunPk =
    typeof credential.aliyunPk === 'string' && credential.aliyunPk.length > 0
      ? credential.aliyunPk
      : null;
  const isg =
    typeof credential.isg === 'string' && credential.isg.length > 0 ? credential.isg : null;
  const esmTicket =
    typeof credential.esmTicket === 'string' && credential.esmTicket.length > 0
      ? credential.esmTicket
      : undefined;
  return { ticket, aliyunPk, isg, esmTicket, accountKey: record.accountHint ?? null };
}

/**
 * Build the canonical QwenCloud cookie string (verbatim from the
 * home.qwencloud.com web client).
 *
 * @param {{ ticket: string, aliyunPk: string, isg: string, esmTicket?: string }} cred
 * @returns {string}
 */
function qwencloudCookieString(cred) {
  let c = `login_qwencloud_ticket=${cred.ticket}; isg=${cred.isg}`;
  if (cred.aliyunPk) c += `; login_aliyunid_pk=${cred.aliyunPk}`;
  if (cred.esmTicket) c += `; login_ESM_account_ticket=${cred.esmTicket}`;
  return c;
}

/**
 * Build the canonical QwenCloud request headers (verbatim from the
 * home.qwencloud.com web client). Content-Type is omitted for the
 * homepage GET and added by the caller for the POSTs.
 *
 * @param {{ ticket: string, aliyunPk: string, isg: string, esmTicket?: string }} cred
 * @returns {Record<string, string>}
 */
function qwencloudHeaders(cred) {
  return {
    Cookie: qwencloudCookieString(cred),
    'bx-v': QWENCLOUD_BX_V,
    Referer: `${QWENCLOUD_BASE}/`,
    Origin: QWENCLOUD_BASE,
    'User-Agent': QWENCLOUD_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
  };
}

/**
 * Transform the canonical QwenCloud subscription summary + auto-renewal
 * flag into OpenChamber usage windows + footer.
 *
 * @param {object} subData - QwenCloudSubSummaryResponse (code === '200')
 * @param {boolean|null} autoRenewal - true/false from renewal, or null if unavailable
 * @returns {{ windows: object, footer?: string[] }}
 */
function transformQuota(subData, autoRenewal) {
  const data = subData?.data?.Data;
  if (!data) {
    // No active subscription — faithful canonical placeholder.
    return { windows: {}, footer: ['QwenCloud: no active subscription'] };
  }

  const group = Array.isArray(data.SubscriptionGroupList) ? data.SubscriptionGroupList[0] : null;
  const equity =
    group && Array.isArray(group.EquityList)
      ? group.EquityList.find((e) => e && e.EquityType === 'CREDITS')
      : null;

  if (!equity) {
    return { windows: {}, footer: ['QwenCloud: no active subscription'] };
  }

  const seats = group.SubscriptionTotalNumber ?? 1;
  const spec = group.SpecType ?? 'standard';

  const total = Number(equity.TotalValue);
  const surplus = Number(equity.SurplusValue);
  const used = total - surplus;
  const remainingPct = total > 0 ? Math.round((surplus / total) * 100) : 100;
  const usedPercent = 100 - remainingPct;

  const resetTs = toTimestamp(group.NextCycleFlushTime);
  const resetAt = resetTs !== null ? new Date(resetTs).toISOString() : null;

  let sectionHeader = `Token Plan Team Edition (${spec}, ${seats} seat${seats > 1 ? 's' : ''})`;
  if (autoRenewal !== null) {
    sectionHeader += ` · auto-renewal: ${autoRenewal ? 'enabled' : 'disabled'}`;
  }

  const windows = {
    credits: toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel: `Credits (${data.RemainingDays ?? '?'}d remaining)`,
      detail: [`Used: ${used.toLocaleString()} / ${total.toLocaleString()}`],
      sectionHeader,
    }),
  };

  const footer = [];
  if (data.EndTime) {
    const startIso = new Date(data.StartTime).toISOString().slice(0, 10);
    const endIso = new Date(data.EndTime).toISOString().slice(0, 10);
    footer.push(`Cycle: ${startIso} — ${endIso}`);
  }

  return { windows, footer: footer.length ? footer : undefined };
}

export const isConfigured = () => {
  const { ticket, isg } = resolveCredential();
  return Boolean(ticket && isg);
};

export const fetchQuota = async () => {
  const { ticket, aliyunPk, isg, esmTicket, accountKey } = resolveCredential();

  if (!ticket || !isg) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const cred = { ticket, aliyunPk, isg, esmTicket };
  const baseHeaders = qwencloudHeaders(cred);

  try {
    // Step 1: GET homepage, extract SEC_TOKEN from inline JS.
    const homeResponse = await fetchWithRetry(HOMEPAGE_URL, {
      method: 'GET',
      headers: baseHeaders,
      maxRetries: 2,
      retryDelay: 1000,
    });

    if (!homeResponse.ok) {
      // No cache fallback: a stale snapshot cannot confirm credential validity.
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `Homepage API error: ${homeResponse.status}`,
      });
    }

    const html = await homeResponse.text();
    const tokenMatch = html.match(SEC_TOKEN_REGEX);
    if (!tokenMatch) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Could not extract SEC_TOKEN (session may have expired)',
      });
    }
    const secToken = tokenMatch[1];

    // Step 2: subscription summary + auto-renewal in parallel. Renewal is
    // best-effort — its transient failure does NOT reject the overall
    // fetch (wrapped in .catch(() => null)).
    const subBody = new URLSearchParams({
      product: 'BssOpenAPI-V3',
      action: 'GetSeatSubscriptionSummary',
      sec_token: secToken,
      region: REGION,
      params: JSON.stringify({ productCode: PRODUCT_CODE }),
    });
    const renewalBody = new URLSearchParams({
      product: 'BssOpenApi',
      action: 'CheckTokenPlanAutoRenewal',
      sec_token: secToken,
      region: REGION,
      params: JSON.stringify({ CommodityCode: PRODUCT_CODE }),
    });

    const postHeaders = { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded' };

    const [subResponse, renewalResponse] = await Promise.all([
      fetchWithRetry(SUB_SUMMARY_URL, {
        method: 'POST',
        headers: postHeaders,
        body: subBody,
        maxRetries: 2,
        retryDelay: 1000,
      }),
      fetchWithRetry(RENEWAL_URL, {
        method: 'POST',
        headers: postHeaders,
        body: renewalBody,
        maxRetries: 2,
        retryDelay: 1000,
      }).catch(() => null),
    ]);

    if (!subResponse.ok) {
      // 401/403/4xx — auth or request errors. No cache fallback.
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${subResponse.status}`,
      });
    }

    let subData;
    try {
      subData = await subResponse.json();
    } catch {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Invalid response from provider',
      });
    }

    // Parse auto-renewal only if renewal succeeded.
    let autoRenewal = null;
    if (renewalResponse?.ok) {
      try {
        const renewalData = await renewalResponse.json();
        const rd = renewalData?.data;
        autoRenewal = rd?.Success ? rd.Data?.AutoRenewal === 1 : null;
      } catch {
        // tolerate — renewal is enrichment only
      }
    }

    const usage = transformQuota(subData, autoRenewal);

    const result = buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage,
    });

    resultCache.set(accountKey, { ...result, cachedAt: Date.now() });
    return result;
  } catch (error) {
    // Retryable failure (429/5xx exhausted, network error, timeout) of
    // the homepage or subscription fetch. Fall back to cached result if
    // available.
    const cached = resultCache.get(accountKey);
    if (cached) {
      return {
        ...cached,
        ok: true,
        isStale: true,
        fetchedAt: Date.now(),
      };
    }
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};