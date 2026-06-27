/**
 * StepFun (Oasis) quota provider
 *
 * Cookie/token-based manual-auth provider for the StepFun Token Plan.
 * Credentials are stored via the credential registry (`getCredential`)
 * and API calls go through `fetchWithRetry` for timeout, retry, and
 * backoff handling.
 *
 * Canonical API (ported from platform.stepfun.ai dashboard, source of
 * truth: mystatus/plugin/mystatus.ts):
 *   POST https://platform.stepfun.ai/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit
 *        body `{}`
 *     -> StepFunRateLimitResponse { status, desc, five_hour_usage_left_rate,
 *          five_hour_usage_reset_time, weekly_usage_left_rate,
 *          weekly_usage_reset_time }
 *   POST https://platform.stepfun.ai/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus
 *        body `{}`
 *     -> StepFunPlanStatusResponse { status, desc, subscription: {...},
 *          plan_definition: {...}, can_resign }
 *
 * Auth shape (from credentials/schemas.js):
 *   - `oasisToken`  (required): sent as `Oasis-Token` cookie
 *   - `oasisWebid`  (required): sent as `Oasis-Webid` cookie + `oasis-webid` header
 *   - `sessionToken` (optional): sent as `__Secure-next-auth.session-token` cookie
 *
 * Rates are fractional remaining (1 = full, 0.5 = half left). Reset times
 * are epoch-second strings. A `status` field equal to 1 marks a successful
 * response; any other value means no data for that endpoint.
 *
 * On retryable failures (429/5xx after retry exhaustion, network errors,
 * timeouts) the provider falls back to the last successful result marked
 * `isStale: true`. Auth failures (401/403) and parse errors do NOT trigger
 * cache fallback — a stale snapshot cannot confirm whether the credential
 * is still valid.
 *
 * Tokens and cookies are never included in error messages.
 *
 * @module quota/providers/stepfun
 */

import { getCredential } from '../credentials/store.js';
import {
  fetchWithRetry,
  buildResult,
  toUsageWindow,
  toNumber,
} from '../utils/index.js';

export const providerId = 'stepfun';
export const providerName = 'StepFun';

const STEPFUN_DASHBOARD_BASE = 'https://platform.stepfun.ai';
const STEPFUN_OASIS_APPID = '20700';
const STEPFUN_USER_AGENT = 'OpenCode-AllStatus/1.0';

const RATE_LIMIT_URL = `${STEPFUN_DASHBOARD_BASE}/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit`;
const PLAN_STATUS_URL = `${STEPFUN_DASHBOARD_BASE}/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus`;

const FIVE_HOUR_SECONDS = 5 * 3600;
const WEEKLY_SECONDS = 7 * 86400;

/**
 * In-memory cache of the last successful result, keyed by accountHint.
 * Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Resolve the oasisToken, oasisWebid, and optional sessionToken from the
 * credential store. Both oasisToken and oasisWebid are required (the
 * canonical stepfun-cookies.json loader requires `oasisToken &&
 * oasisWebid`).
 *
 * @returns {{ oasisToken: string|null, oasisWebid: string|null, sessionToken?: string, accountKey: string|null }}
 */
function resolveCredential() {
  const record = getCredential(providerId);
  if (!record?.credential) return { oasisToken: null, oasisWebid: null, accountKey: null };
  const credential = record.credential;
  const oasisToken =
    typeof credential.oasisToken === 'string' && credential.oasisToken.length > 0
      ? credential.oasisToken
      : null;
  const oasisWebid =
    typeof credential.oasisWebid === 'string' && credential.oasisWebid.length > 0
      ? credential.oasisWebid
      : null;
  const sessionToken =
    typeof credential.sessionToken === 'string' && credential.sessionToken.length > 0
      ? credential.sessionToken
      : undefined;
  return { oasisToken, oasisWebid, sessionToken, accountKey: record.accountHint ?? null };
}

/**
 * Build the canonical StepFun dashboard request headers (verbatim from
 * the platform.stepfun.ai web client).
 *
 * @param {{ oasisToken: string, oasisWebid: string, sessionToken?: string }} cred
 * @returns {Record<string, string>}
 */
function stepfunHeaders(cred) {
  const cookieParts = [
    `Oasis-Token=${cred.oasisToken}`,
    `Oasis-Webid=${cred.oasisWebid}`,
  ];
  if (cred.sessionToken) {
    cookieParts.push(`__Secure-next-auth.session-token=${cred.sessionToken}`);
  }
  return {
    'Content-Type': 'application/json',
    'oasis-appid': STEPFUN_OASIS_APPID,
    'oasis-platform': 'web',
    'oasis-webid': cred.oasisWebid,
    Cookie: cookieParts.join('; '),
    Origin: STEPFUN_DASHBOARD_BASE,
    Referer: `${STEPFUN_DASHBOARD_BASE}/plan-usage`,
    'User-Agent': STEPFUN_USER_AGENT,
    Accept: 'application/json',
  };
}

/**
 * Convert a canonical epoch-second timestamp (number or numeric string)
 * into an ISO string, mirroring the canonical `stepfunResetAt`. Returns
 * null when unparseable.
 *
 * @param {string|number|undefined} value
 * @returns {string|null}
 */
function epochSecondsToIso(value) {
  const n = toNumber(value);
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1_000_000_000_000 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Convert a remaining rate (0..1) to a clamped integer remaining percent
 * (0..100), mirroring the canonical `Math.round(left_rate * 100)`.
 *
 * @param {number|string|undefined} rate
 * @returns {number|null}
 */
function remainingRateToPercent(rate) {
  const n = toNumber(rate);
  if (n === null || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

/**
 * Transform the canonical StepFun responses into OpenChamber usage
 * windows + header + footer.
 *
 * @param {object|null} rateLimit - StepFunRateLimitResponse (status===1) or null
 * @param {object|null} planStatus - StepFunPlanStatusResponse (status===1) or null
 * @returns {{ windows: object, header?: string[], footer?: string[] }|null}
 */
function transformQuota(rateLimit, planStatus) {
  const windows = {};

  if (rateLimit) {
    const fiveHourRemaining = remainingRateToPercent(rateLimit.five_hour_usage_left_rate);
    if (fiveHourRemaining !== null) {
      windows['5h'] = toUsageWindow({
        usedPercent: 100 - fiveHourRemaining,
        windowSeconds: FIVE_HOUR_SECONDS,
        resetAt: epochSecondsToIso(rateLimit.five_hour_usage_reset_time),
        valueLabel: `${fiveHourRemaining}% left`,
      });
    }
    const weeklyRemaining = remainingRateToPercent(rateLimit.weekly_usage_left_rate);
    if (weeklyRemaining !== null) {
      windows.weekly = toUsageWindow({
        usedPercent: 100 - weeklyRemaining,
        windowSeconds: WEEKLY_SECONDS,
        resetAt: epochSecondsToIso(rateLimit.weekly_usage_reset_time),
        valueLabel: `${weeklyRemaining}% left`,
      });
    }
  }

  const header = [];
  const footer = [];

  const plan = planStatus?.subscription;
  const def = planStatus?.plan_definition;

  if (plan) {
    header.push(`Plan:           ${plan.name}`);
    const expIso = epochSecondsToIso(plan.expired_at);
    if (plan.auto_renew) {
      if (expIso) header.push(`Renews:          ${expIso}`);
    } else {
      if (expIso) header.push(`Expires:         ${expIso}`);
    }
    if (def?.price) {
      const priceNum = toNumber(def.price);
      if (priceNum !== null && Number.isFinite(priceNum)) {
        header.push(`Price:           $${(priceNum / 100).toFixed(2)}/mo`);
      }
    }
  }

  if (def?.support_models?.length) {
    footer.push(`Models:         ${def.support_models.join(', ')}`);
  }

  if (Object.keys(windows).length === 0 && header.length === 0 && footer.length === 0) {
    return null;
  }

  return {
    windows,
    header: header.length ? header : undefined,
    footer: footer.length ? footer : undefined,
  };
}

export const isConfigured = () => {
  const { oasisToken, oasisWebid } = resolveCredential();
  return Boolean(oasisToken && oasisWebid);
};

export const fetchQuota = async () => {
  const { oasisToken, oasisWebid, sessionToken, accountKey } = resolveCredential();

  if (!oasisToken || !oasisWebid) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const headers = stepfunHeaders({ oasisToken, oasisWebid, sessionToken });

  try {
    // Both canonical endpoints are POST with body `{}`, called in parallel
    // (mirrors the canonical Promise.all in mystatus).
    const [rateRes, planRes] = await Promise.all([
      fetchWithRetry(RATE_LIMIT_URL, {
        method: 'POST',
        headers,
        body: '{}',
        maxRetries: 2,
        retryDelay: 1000,
      }),
      fetchWithRetry(PLAN_STATUS_URL, {
        method: 'POST',
        headers,
        body: '{}',
        maxRetries: 2,
        retryDelay: 1000,
      }),
    ]);

    // 401/403/4xx on the primary endpoint — auth or request errors.
    // No cache fallback: a stale snapshot cannot confirm whether the
    // credential is still valid.
    if (!rateRes.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${rateRes.status}`,
      });
    }

    let rateLimit = null;
    try {
      const data = await rateRes.json();
      if (data && typeof data === 'object' && data.status === 1) rateLimit = data;
    } catch {
      // keep null — parse error does not trigger cache fallback
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Invalid response from provider',
      });
    }

    let planStatus = null;
    if (planRes.ok) {
      try {
        const data = await planRes.json();
        if (data && typeof data === 'object' && data.status === 1) planStatus = data;
      } catch {
        // tolerate — plan-status is enrichment only
      }
    }

    const usage = transformQuota(rateLimit, planStatus);
    if (!usage) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

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
    // Retryable failure (429/5xx exhausted, network error, timeout).
    // Fall back to cached result if available.
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