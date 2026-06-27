/**
 * AtlasCloud quota provider
 *
 * Cookie-based manual-auth provider for the AtlasCloud Coding Plan.
 * Credentials are stored via the credential registry (`getCredential`)
 * and API calls go through `fetchWithRetry` for timeout, retry, and
 * backoff handling.
 *
 * Canonical API (ported from console.atlascloud.ai, source of truth:
 * mystatus/plugin/mystatus.ts):
 *   GET  https://console.atlascloud.ai/api/v1/current-user
 *   POST https://console.atlascloud.ai/api/v1/codeplan/get   (empty body)
 *   GET  https://console.atlascloud.ai/api/v1/codeplan/costs (query params)
 *
 * Auth shape (from credentials/schemas.js):
 *   - `cookie` (required): must contain `access-token=`
 *   - `accountUuid` (optional): sent as `X-Account-ID` when present; if
 *     absent, resolved from `current-user.data.currentAccountUuid`.
 *
 * On retryable failures (429/5xx after retry exhaustion, network
 * errors, timeouts) the provider falls back to the last successful
 * result marked `isStale: true`. Auth failures (401/403) and parse
 * errors do NOT trigger cache fallback — a stale snapshot cannot
 * confirm whether the credential is still valid.
 *
 * Cookies and JWTs are never included in error messages.
 *
 * @module quota/providers/atlascloud
 */

import { getCredential } from '../credentials/store.js';
import {
  fetchWithRetry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
} from '../utils/index.js';

export const providerId = 'atlascloud';
export const providerName = 'AtlasCloud';

const ATLASCLOUD_BASE = 'https://console.atlascloud.ai';
const ATLASCLOUD_REFERER = 'https://www.atlascloud.ai/';
const ATLASCLOUD_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0';

const CURRENT_USER_URL = `${ATLASCLOUD_BASE}/api/v1/current-user`;
const CODEPLAN_GET_URL = `${ATLASCLOUD_BASE}/api/v1/codeplan/get`;
const CODEPLAN_COSTS_URL = `${ATLASCLOUD_BASE}/api/v1/codeplan/costs`;

const DAILY_WINDOW_SECONDS = 86400;
const COSTS_WINDOW_MS = 86_400_000;
const COSTS_PAGE_SIZE = 5;

/**
 * In-memory cache of the last successful result, keyed by accountHint.
 * Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Resolve the cookie and accountUuid from the credential store.
 *
 * @returns {{ cookie: string|null, accountUuid?: string, accountKey: string|null }}
 */
function resolveCredential() {
  const record = getCredential(providerId);
  if (!record?.credential) return { cookie: null, accountKey: null };
  const cookie = typeof record.credential.cookie === 'string' ? record.credential.cookie : null;
  const accountUuid =
    typeof record.credential.accountUuid === 'string' && record.credential.accountUuid
      ? record.credential.accountUuid
      : undefined;
  return { cookie, accountUuid, accountKey: record.accountHint ?? null };
}

/**
 * Build the canonical AtlasCloud request headers (verbatim from the
 * console.atlascloud.ai web client).
 *
 * @param {string} cookie
 * @param {string} [accountUuid]
 * @returns {Record<string, string>}
 */
function atlasHeaders(cookie, accountUuid) {
  const headers = {
    Cookie: cookie,
    'User-Agent': ATLASCLOUD_USER_AGENT,
    Accept: '*/*',
    Origin: 'https://www.atlascloud.ai',
    Referer: ATLASCLOUD_REFERER,
    'Content-Type': 'application/json',
  };
  if (accountUuid) headers['X-Account-ID'] = accountUuid;
  return headers;
}

/**
 * Format an AtlasCloud subscription expiry timestamp (seconds or ms) into
 * an ISO string, mirroring the canonical `formatAtlasExpiry`.
 *
 * @param {number} expiredAt
 * @returns {{ iso: string|null, text: string }}
 */
function formatExpiry(expiredAt) {
  const n = toNumber(expiredAt);
  if (n === null || !Number.isFinite(n) || n <= 0) return { iso: null, text: '-' };
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return { iso: null, text: '-' };
  return { iso: date.toISOString(), text: date.toISOString().slice(0, 10) };
}

/**
 * Next UTC midnight as an ISO string, mirroring the canonical
 * `nextDailyResetIso`.
 *
 * @returns {string}
 */
function nextDailyResetIso() {
  const now = new Date();
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return reset.toISOString();
}

/**
 * Pick the active subscription from a codeplan/get `data` array.
 * Mirrors the canonical selection: first `Status` matching /active/i,
 * otherwise the first entry.
 *
 * @param {object[]} subs
 * @returns {object|null}
 */
function pickActiveSubscription(subs) {
  if (!Array.isArray(subs) || subs.length === 0) return null;
  return subs.find((s) => s && typeof s === 'object' && /active/i.test(String(s.Status))) ?? subs[0];
}

/**
 * Transform the canonical AtlasCloud responses into OpenChamber usage
 * windows + footer.
 *
 * @param {object} subscription - active AtlasCodePlanSubscription
 * @param {object|null} costsData - AtlasCodePlanCostsResponse.data (or null)
 * @returns {{ windows: object, footer?: string[] }}
 */
function transformQuota(subscription, costsData) {
  const planName =
    typeof subscription.PlanName === 'string' && subscription.PlanName ? subscription.PlanName : null;
  const planType =
    typeof subscription.PlanType === 'string' && subscription.PlanType ? subscription.PlanType : '';
  const price = typeof subscription.Price === 'string' ? subscription.Price : '';
  const status = typeof subscription.Status === 'string' ? subscription.Status : '';
  const autoRenewal = Boolean(subscription.AutoRenewal);

  const dailyQuota = toNumber(subscription.DailyQuota);
  const balance = toNumber(subscription.balance);

  // Canonical: remainingPct = round(balance / dailyQuota * 100), clamped 0-100.
  const remainingPct =
    dailyQuota !== null && balance !== null && dailyQuota > 0
      ? Math.max(0, Math.min(100, Math.round((balance / dailyQuota) * 100)))
      : 0;
  const usedPercent = 100 - remainingPct;

  const detail = [];
  if (balance !== null && dailyQuota !== null) {
    const usedToday = Math.round(dailyQuota - balance);
    detail.push(`Used today:     ${usedToday.toLocaleString()} / ${dailyQuota.toLocaleString()}`);
  }

  const windows = {
    '1d': toUsageWindow({
      usedPercent,
      windowSeconds: DAILY_WINDOW_SECONDS,
      resetAt: nextDailyResetIso(),
      valueLabel: planName ?? undefined,
      detail: detail.length ? detail : undefined,
    }),
  };

  const footer = [];

  // Subscription expiry line (canonical footer).
  const expiry = formatExpiry(subscription.ExpiredAt);
  if (expiry.iso) {
    footer.push(`Subscription expires: ${expiry.text} (${expiry.iso.slice(0, 10)})`);
  }

  // Plan/status context lines (canonical header content, surfaced as footer
  // context in OpenChamber's single-card layout).
  if (planName) {
    footer.push(`Plan:           AtlasCloud ${planName} ($${price}/${planType})`);
  }
  footer.push(`Status:         ${status}${autoRenewal ? ' · auto-renew' : ''}`);

  // Recent costs block (canonical footer from codeplan/costs).
  if (costsData && Array.isArray(costsData.items) && costsData.items.length) {
    const items = costsData.items.slice(0, COSTS_PAGE_SIZE);
    const usedToday = items.reduce((sum, it) => sum + (toNumber(it.amount) ?? 0), 0);
    footer.push('');
    footer.push(`Recent calls (last 24h, ${costsData.total} total, top ${items.length}):`);
    for (const it of items) {
      const finishTs = toTimestamp(it.finishTime);
      const time = finishTs ? new Date(finishTs).toISOString().slice(11, 16) : '--:--';
      const cost = Math.round(toNumber(it.amount) ?? 0).toLocaleString();
      const inT = toNumber(it.usage?.input) ?? 0;
      const outT = toNumber(it.usage?.output) ?? 0;
      const model = typeof it.model === 'string' ? it.model : '';
      footer.push(
        `  ${time}  ${model.padEnd(30)} ${String(inT).padStart(6)}in/${String(outT).padStart(4)}out  -${cost}`,
      );
    }
    if (Number.isFinite(usedToday)) {
      footer.push(`  (top-${items.length} 24h burn: -${Math.round(usedToday).toLocaleString()})`);
    }
  }

  return { windows, footer: footer.length ? footer : undefined };
}

export const isConfigured = () => {
  const { cookie } = resolveCredential();
  return Boolean(cookie && cookie.includes('access-token='));
};

export const fetchQuota = async () => {
  const { cookie, accountUuid, accountKey } = resolveCredential();

  if (!cookie) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  // Defensive structural check — mirrors schema validation at fetch time.
  if (!cookie.includes('access-token=')) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Malformed credential: cookie must contain access-token=',
    });
  }

  try {
    // 1. GET /current-user — resolve accountUuid + account label when not
    //    supplied by the credential. Tolerate failure (fall back to
    //    configured accountUuid).
    let resolvedAccountUuid = accountUuid;
    try {
      const userResponse = await fetchWithRetry(CURRENT_USER_URL, {
        headers: atlasHeaders(cookie),
        maxRetries: 2,
        retryDelay: 1000,
      });
      if (userResponse.ok) {
        const userPayload = await userResponse.json();
        const userData = userPayload?.data && typeof userPayload.data === 'object' ? userPayload.data : null;
        if (userData) {
          resolvedAccountUuid =
            resolvedAccountUuid ??
            (typeof userData.currentAccountUuid === 'string' && userData.currentAccountUuid
              ? userData.currentAccountUuid
              : undefined);
        }
      }
    } catch {
      // tolerate — fall back to configured accountUuid.
    }

    if (!resolvedAccountUuid) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Could not resolve accountUuid (current-user failed and no accountUuid configured)',
      });
    }

    // 2. POST /codeplan/get — canonical empty body, X-Account-ID header.
    const planResponse = await fetchWithRetry(CODEPLAN_GET_URL, {
      method: 'POST',
      headers: atlasHeaders(cookie, resolvedAccountUuid),
      body: '',
      maxRetries: 2,
      retryDelay: 1000,
    });

    if (!planResponse.ok) {
      // 401/403/4xx — auth or request errors. No cache fallback: a stale
      // snapshot cannot confirm whether the credential is still valid.
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${planResponse.status}`,
      });
    }

    let planPayload;
    try {
      planPayload = await planResponse.json();
    } catch {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Invalid response from provider',
      });
    }

    const subs = Array.isArray(planPayload?.data) ? planPayload.data : [];
    const active = pickActiveSubscription(subs);

    if (!active) {
      // No subscription — return an empty (but successful) usage shape.
      const result = buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: { windows: {} },
      });
      resultCache.set(accountKey, { ...result, cachedAt: Date.now() });
      return result;
    }

    // 3. GET /codeplan/costs — recent 24h burn (best-effort, never fatal).
    let costsData = null;
    try {
      const now = Date.now();
      const costsUrl = new URL(CODEPLAN_COSTS_URL);
      costsUrl.searchParams.set('pageNo', '1');
      costsUrl.searchParams.set('pageSize', String(COSTS_PAGE_SIZE));
      costsUrl.searchParams.set('startTime', String(now - COSTS_WINDOW_MS));
      costsUrl.searchParams.set('endTime', String(now));
      const costsResponse = await fetchWithRetry(costsUrl.toString(), {
        headers: atlasHeaders(cookie, resolvedAccountUuid),
        maxRetries: 2,
        retryDelay: 1000,
      });
      if (costsResponse.ok) {
        const costsPayload = await costsResponse.json();
        costsData =
          costsPayload?.data && typeof costsPayload.data === 'object' ? costsPayload.data : null;
      }
    } catch {
      // tolerate — costs are enrichment only.
    }

    const usage = transformQuota(active, costsData);

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