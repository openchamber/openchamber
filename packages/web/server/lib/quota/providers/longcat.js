/**
 * LongCat quota provider
 *
 * Cookie/passport-token manual-auth provider for the LongCat platform
 * (longcat.chat). Credentials are stored via the credential registry
 * (`getCredential`) and API calls go through `fetchWithRetry` for timeout,
 * retry, and backoff handling.
 *
 * Canonical API (ported from longcat.chat, source of truth:
 * mystatus/plugin/mystatus.ts):
 *   GET https://longcat.chat/api/lc-platform/v1/tokenUsage?day=today
 *   GET https://longcat.chat/api/v1/user-current
 *   GET https://longcat.chat/api/lc-platform/v1/query-active-apiKeys
 *
 * Auth shape (from credentials/schemas.js):
 *   - `passportToken` (string): when present, the cookie is built as
 *     `passport_token_key=<passportToken>; long_cat_region_key=<region>`.
 *   - `cookie` (string): must contain `passport_token_key=`; used verbatim.
 *   - `region` (optional): defaults to "2" when building the cookie from
 *     `passportToken`; ignored when `cookie` is supplied directly.
 *
 * Canonical envelope: `{ code: number, message: string, data: T | null }`.
 * `code === 0` is success; `code === 401` or a "not logged in" message is an
 * auth failure (no stale fallback). Other non-zero codes are hard errors.
 *
 * On retryable failures (429/5xx after retry exhaustion, network errors,
 * timeouts) the provider falls back to the last successful result marked
 * `isStale: true`. Auth failures (401/403, envelope code 401) and parse
 * errors do NOT trigger cache fallback — a stale snapshot cannot confirm
 * whether the credential is still valid.
 *
 * Cookies and passport tokens are never included in error messages.
 *
 * @module quota/providers/longcat
 */

import { getCredential } from '../credentials/store.js';
import { fetchWithRetry, buildResult, toUsageWindow, toNumber } from '../utils/index.js';

export const providerId = 'longcat';
export const providerName = 'LongCat';

const LONGCAT_BASE = 'https://longcat.chat';
const LONGCAT_APPKEY = 'fe_com.sankuai.friday.longcat.platform';
const LONGCAT_REFERER = 'https://longcat.chat/platform/usage';
const LONGCAT_USER_AGENT = 'OpenCode-AllStatus/1.0';
const DEFAULT_REGION = '2';

const TOKEN_USAGE_URL = `${LONGCAT_BASE}/api/lc-platform/v1/tokenUsage?day=today`;
const USER_CURRENT_URL = `${LONGCAT_BASE}/api/v1/user-current`;
const API_KEYS_URL = `${LONGCAT_BASE}/api/lc-platform/v1/query-active-apiKeys`;

const DAILY_WINDOW_SECONDS = 86400;

// Canonical LONGCAT_EXT_SKIP_KEYS — extData entries with these keys are not
// model usage records and must be skipped.
const EXT_SKIP_KEYS = new Set(['applyButtonGray', 'newUser']);

/**
 * In-memory cache of the last successful result, keyed by accountHint.
 * Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Resolve the cookie, passportToken, and region from the credential store.
 *
 * Per canonical `resolveLongCatSession`: if `passportToken` is present, the
 * session is `{ passportToken, region }` and the cookie is built at request
 * time as `passport_token_key=<token>; long_cat_region_key=<region>`. If
 * only `cookie` is present, the passport/region are parsed out of it for
 * cookie-rebuild purposes, but the original cookie string is sent verbatim
 * (canonical `longcatPlatformHeaders` always rebuilds from the session; the
 * OpenChamber port preserves the user-supplied cookie as-is to avoid
 * dropping extra cookies the user may have included).
 *
 * @returns {{ cookie: string|null, passportToken: string|null, region: string, accountKey: string|null }}
 */
function resolveCredential() {
  const record = getCredential(providerId);
  if (!record?.credential) return { cookie: null, passportToken: null, region: DEFAULT_REGION, accountKey: null };
  const cred = record.credential;

  const passportFromField =
    typeof cred.passportToken === 'string' ? cred.passportToken.trim() : '';
  if (passportFromField) {
    const region =
      typeof cred.region === 'string' && cred.region.trim() ? cred.region.trim() : DEFAULT_REGION;
    return {
      cookie: `passport_token_key=${passportFromField}; long_cat_region_key=${region}`,
      passportToken: passportFromField,
      region,
      accountKey: record.accountHint ?? null,
    };
  }

  const cookie = typeof cred.cookie === 'string' ? cred.cookie.trim() : '';
  if (!cookie) {
    return { cookie: null, passportToken: null, region: DEFAULT_REGION, accountKey: record.accountHint ?? null };
  }

  // Parse passport/region out of the cookie for session consistency, but
  // send the cookie verbatim.
  const passport = cookie.match(/(?:^|;\s*)passport_token_key=([^;]+)/)?.[1]?.trim() ?? null;
  const region =
    cookie.match(/(?:^|;\s*)long_cat_region_key=([^;]+)/)?.[1]?.trim() || DEFAULT_REGION;
  return { cookie, passportToken: passport, region, accountKey: record.accountHint ?? null };
}

/**
 * Build the canonical LongCat platform request headers (verbatim from
 * `longcatPlatformHeaders`).
 *
 * @param {string} cookie
 * @returns {Record<string, string>}
 */
function longcatHeaders(cookie) {
  return {
    Cookie: cookie,
    'm-appkey': LONGCAT_APPKEY,
    'content-type': 'application/json',
    'x-client-language': 'en',
    'x-requested-with': 'XMLHttpRequest',
    Accept: '*/*',
    Referer: LONGCAT_REFERER,
    'User-Agent': LONGCAT_USER_AGENT,
  };
}

/**
 * Canonical `longcatRemainPercent`: round(remaining / total * 100), clamped
 * 0-100. Returns 0 when total is non-finite or <= 0, or remaining is
 * non-finite.
 *
 * @param {number} remaining
 * @param {number} total
 * @returns {number}
 */
function remainPercent(remaining, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
}

/**
 * Canonical `longcatModelEntries`: extract model usage entries from the
 * tokenUsage `extData` object, skipping non-model keys and entries without
 * numeric token fields. Returns entries sorted by key (localeCompare).
 *
 * @param {Record<string, unknown>} [extData]
 * @returns {Array<[string, object]>}
 */
function modelEntries(extData) {
  if (!extData || typeof extData !== 'object') return [];
  const out = [];
  for (const [key, val] of Object.entries(extData)) {
    if (EXT_SKIP_KEYS.has(key)) continue;
    if (!val || typeof val !== 'object') continue;
    const usage = val;
    if (
      typeof usage.totalToken !== 'number' &&
      typeof usage.freeRefreshToken !== 'number' &&
      typeof usage.availableToken !== 'number'
    ) {
      continue;
    }
    out.push([key, usage]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Canonical `longcatFuelSummary`: summarize active fuel packages.
 *
 * @param {object[]|null} [packages]
 * @returns {string[]}
 */
function fuelSummary(packages) {
  if (!Array.isArray(packages) || packages.length === 0) return [];
  const active = packages.filter((p) => (toNumber(p?.remainQuota) ?? 0) > 0);
  if (active.length === 0) return [];
  const totalRemain = active.reduce((sum, p) => sum + (toNumber(p.remainQuota) ?? 0), 0);
  const nearestExpire = active.reduce((min, p) => {
    const days = toNumber(p.daysUntilExpire);
    if (days === null || !Number.isFinite(days)) return min;
    return min === null ? days : Math.min(min, days);
  }, null);
  const lines = [
    `Fuel packages:  ${active.length} active · ${totalRemain.toLocaleString()} tokens remaining`,
  ];
  if (nearestExpire !== null) {
    lines.push(`Nearest expiry: ${nearestExpire}d`);
  }
  return lines;
}

/**
 * Transform the canonical LongCat responses into OpenChamber usage windows
 * + footer, mirroring the canonical card assembly.
 *
 * @param {object} usageData - tokenUsage data ({ extData, usage })
 * @param {object|null} userData - user-current data ({ email, name, userId }) or null
 * @param {object|null} keysData - query-active-apiKeys data ({ extData: { activeKeyCount } }) or null
 * @returns {{ windows: object, footer?: string[] }}
 */
function transformQuota(usageData, userData, keysData) {
  const models = modelEntries(usageData?.extData);

  // Header lines (canonical): account, plan, active API keys.
  const header = [];
  const email = userData?.email;
  const name = userData?.name;
  if (typeof email === 'string' && email) header.push(`Account:        ${email}`);
  else if (typeof name === 'string' && name) header.push(`Account:        ${name}`);
  header.push('Plan:           LongCat API');

  const activeKeys = keysData?.extData?.activeKeyCount;
  if (typeof activeKeys === 'number') {
    header.push(`Active API keys: ${activeKeys}`);
  }

  if (models.length === 0) {
    // Canonical: no usage data -> single card with header only, no windows.
    return { windows: {}, footer: header.length ? header : undefined };
  }

  // Filter to models with any non-zero quota (canonical displayModels).
  const displayModels = models.filter(([, usage]) => {
    const freeTotal = toNumber(usage.freeRefreshToken) ?? 0;
    const total = toNumber(usage.totalToken) ?? 0;
    return freeTotal > 0 || total > 0;
  });

  if (displayModels.length === 0) {
    // Canonical: no active quota -> header + "No active quota" status line.
    header.push('Status:         No active quota returned');
    return { windows: {}, footer: header };
  }

  const multi = displayModels.length > 1;
  const windows = {};
  const footerLines = [...header];
  let windowIdx = 0;

  for (const [modelKey, usage] of displayModels) {
    const label = typeof usage.aliasName === 'string' && usage.aliasName ? usage.aliasName : modelKey;
    const sectionHeader = multi ? label : undefined;

    const freeTotal = toNumber(usage.freeRefreshToken) ?? 0;
    const freeAvail = toNumber(usage.freeAvailableToken) ?? 0;
    if (freeTotal > 0) {
      const freeUsed = toNumber(usage.freeUsedToken) ?? Math.max(0, freeTotal - freeAvail);
      const remaining = remainPercent(freeAvail, freeTotal);
      windows[String(windowIdx++)] = toUsageWindow({
        usedPercent: 100 - remaining,
        windowSeconds: DAILY_WINDOW_SECONDS,
        valueLabel: multi ? `${label} · Free quota` : 'Free quota',
        sectionHeader,
        trendKey: `${label} · Free`,
        detail: [`Used:           ${freeUsed.toLocaleString()} / ${freeTotal.toLocaleString()}`],
      });
    }

    const total = toNumber(usage.totalToken) ?? 0;
    const avail = toNumber(usage.availableToken) ?? 0;
    if (total > 0) {
      const used = toNumber(usage.usedToken) ?? Math.max(0, total - avail);
      const remaining = remainPercent(avail, total);
      windows[String(windowIdx++)] = toUsageWindow({
        usedPercent: 100 - remaining,
        windowSeconds: DAILY_WINDOW_SECONDS,
        valueLabel: multi ? `${label} · Total tokens` : 'Total tokens',
        sectionHeader,
        trendKey: `${label} · Total`,
        detail: [`Used:           ${used.toLocaleString()} / ${total.toLocaleString()}`],
      });
    }

    const fuelLines = fuelSummary(usage.fuelPackageList);
    if (fuelLines.length) {
      footerLines.push(...(multi ? [`${label}:`, ...fuelLines.map((l) => `  ${l}`)] : fuelLines));
    }
  }

  return { windows, footer: footerLines };
}

export const isConfigured = () => {
  const { cookie, passportToken } = resolveCredential();
  if (passportToken) return true;
  return Boolean(cookie && cookie.includes('passport_token_key='));
};

export const fetchQuota = async () => {
  const { cookie, accountKey } = resolveCredential();

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
  if (!cookie.includes('passport_token_key=')) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Malformed credential: cookie must contain passport_token_key=',
    });
  }

  const headers = longcatHeaders(cookie);

  try {
    // 1. GET /api/lc-platform/v1/tokenUsage?day=today — primary quota data.
    const usageResponse = await fetchWithRetry(TOKEN_USAGE_URL, {
      headers,
      maxRetries: 2,
      retryDelay: 1000,
    });

    if (!usageResponse.ok) {
      // 401/403/4xx — auth or request errors. No cache fallback.
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${usageResponse.status}`,
      });
    }

    let usagePayload;
    try {
      usagePayload = await usageResponse.json();
    } catch {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Invalid response from provider',
      });
    }

    // Canonical envelope validation: code 401 / "not logged in" = auth fail.
    const code = toNumber(usagePayload?.code);
    const message = typeof usagePayload?.message === 'string' ? usagePayload.message : '';
    if (code === 401 || /not logged in/i.test(message)) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'LongCat session expired or invalid',
      });
    }
    if (code !== 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `LongCat API error: ${message || `code ${code}`}`,
      });
    }

    const usageData =
      usagePayload?.data && typeof usagePayload.data === 'object' ? usagePayload.data : null;

    // 2. GET /api/v1/user-current — account label (best-effort, never fatal).
    let userData = null;
    try {
      const userResponse = await fetchWithRetry(USER_CURRENT_URL, {
        headers,
        maxRetries: 2,
        retryDelay: 1000,
      });
      if (userResponse.ok) {
        const userPayload = await userResponse.json();
        if (toNumber(userPayload?.code) === 0 && userPayload?.data && typeof userPayload.data === 'object') {
          userData = userPayload.data;
        }
      }
    } catch {
      // tolerate — user info is enrichment only.
    }

    // 3. GET /api/lc-platform/v1/query-active-apiKeys — active key count (best-effort).
    let keysData = null;
    try {
      const keysResponse = await fetchWithRetry(API_KEYS_URL, {
        headers,
        maxRetries: 2,
        retryDelay: 1000,
      });
      if (keysResponse.ok) {
        const keysPayload = await keysResponse.json();
        if (toNumber(keysPayload?.code) === 0 && keysPayload?.data && typeof keysPayload.data === 'object') {
          keysData = keysPayload.data;
        }
      }
    } catch {
      // tolerate — key count is enrichment only.
    }

    const usage = transformQuota(usageData, userData, keysData);

    const result = buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage,
      ...(accountKey ? { accountKey } : {}),
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