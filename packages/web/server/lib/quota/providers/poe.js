/**
 * Poe quota provider
 *
 * API-key provider for the Poe balance API. The key is resolved from
 * OpenCode's own config (auth.json), not a separate manual credential —
 * the same key OpenCode already uses for the `poe` provider. API calls go
 * through `fetchWithRetry` for timeout, retry, and backoff handling.
 *
 * Canonical API (ported from api.poe.com, source of truth:
 * mystatus/plugin/mystatus.ts resolvePoeApiKey):
 *   GET https://api.poe.com/usage/current_balance
 *
 * Auth resolution (mirrors canonical, no manual entry):
 *   1. auth.json `poe` entry: `access` -> `refresh` -> `key`
 *   2. `POE_API_KEY` environment variable
 * Sent as `Authorization: Bearer <apiKey>`.
 *
 * Canonical PoeBalanceResponse fields:
 *   current_point_balance?:    number  (current points balance)
 *   plan_points_balance?:      number
 *   addon_point_balance?:      number
 *   total_balance_usd?:        string  (USD equivalent)
 *   next_daily_grant_time?:    number  (ms epoch)
 *   next_daily_grant_amount?:  number
 *   next_monthly_grant_time?:  number  (ms epoch)
 *   next_monthly_grant_amount?: number
 *
 * On retryable failures (429/5xx after retry exhaustion, network
 * errors, timeouts) the provider falls back to the last successful
 * result marked `isStale: true`. Auth failures (401/403) and parse
 * errors do NOT trigger cache fallback — a stale snapshot cannot
 * confirm whether the credential is still valid.
 *
 * API keys are never included in error messages.
 *
 * @module quota/providers/poe
 */

import { loadAuthMerged } from '../../opencode/auth.js';
import { fetchWithRetry, buildResult, toUsageWindow, toNumber } from '../utils/index.js';

export const providerId = 'poe';
export const providerName = 'Poe';

const POE_BALANCE_URL = 'https://api.poe.com/usage/current_balance';
const POE_USER_AGENT = 'OpenCode-AllStatus/1.0';

/**
 * In-memory cache of the last successful result, keyed by accountHint.
 * Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Resolve the Poe API key from OpenCode auth.json (`poe`: access -> refresh
 * -> key), then the POE_API_KEY env var. Mirrors canonical resolvePoeApiKey;
 * no manual credential entry.
 *
 * @returns {{ apiKey: string|null, accountKey: string|null }}
 */
function resolveCredential() {
  const auth = loadAuthMerged()?.poe;
  if (auth && typeof auth === 'object') {
    for (const field of ['access', 'refresh', 'key']) {
      const value = auth[field];
      if (typeof value === 'string' && value) return { apiKey: value, accountKey: null };
    }
  }
  const env = process.env.POE_API_KEY;
  if (typeof env === 'string' && env) return { apiKey: env, accountKey: null };
  return { apiKey: null, accountKey: null };
}

/**
 * Build the canonical Poe request headers (verbatim from the canonical
 * mystatus implementation).
 *
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
function poeHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': POE_USER_AGENT,
  };
}

/**
 * Normalize a canonical Poe timestamp (ms epoch) into an ISO string,
 * mirroring the canonical `formatPoeTimestamp` reset semantics. Poe
 * timestamps are already in ms epoch.
 *
 * @param {number|undefined} ts
 * @returns {string|null}
 */
function toIso(ts) {
  const n = toNumber(ts);
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Transform the canonical PoeBalanceResponse into OpenChamber usage
 * windows + footer.
 *
 * Canonical mapping (mirrors mystatus queryPoe):
 *   - When `next_monthly_grant_amount > 0`, emit a "monthly" window:
 *       remainingPct = round(current_point_balance / next_monthly_grant_amount * 100)
 *       usedPercent  = 100 - remainingPct
 *       detail       = [`Points: <current> / <grant>`]
 *       resetAt      = ISO(next_monthly_grant_time)
 *       valueLabel   = `<current> pts` (+ USD when total_balance_usd present)
 *   - Footer: add-on points line when `addon_point_balance > 0`.
 *
 * @param {object} balance - PoeBalanceResponse
 * @returns {{ windows: object, footer?: string[] }}
 */
function transformQuota(balance) {
  const currentPts = toNumber(balance.current_point_balance);
  const monthlyGrant = toNumber(balance.next_monthly_grant_amount);
  const addonPts = toNumber(balance.addon_point_balance);
  const usd = typeof balance.total_balance_usd === 'string' ? balance.total_balance_usd : null;

  const windows = {};

  if (monthlyGrant !== null && monthlyGrant > 0 && currentPts !== null) {
    const remainPct = Math.max(0, Math.min(100, Math.round((currentPts / monthlyGrant) * 100)));
    const usedPercent = 100 - remainPct;
    const resetIso = toIso(balance.next_monthly_grant_time);

    const valueLabel = usd ? `${currentPts} pts ($${usd} USD)` : `${currentPts} pts`;
    const detail = [`Points: ${currentPts} / ${monthlyGrant}`];

    windows.monthly = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt: resetIso ?? undefined,
      valueLabel,
      detail,
    });
  }

  const footer = [];
  if (addonPts !== null && addonPts > 0) {
    footer.push(`Add-on points:  ${addonPts}`);
  }

  return { windows, footer: footer.length ? footer : undefined };
}

export const isConfigured = () => {
  const { apiKey } = resolveCredential();
  return Boolean(apiKey);
};

export const fetchQuota = async () => {
  const { apiKey, accountKey } = resolveCredential();

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetchWithRetry(POE_BALANCE_URL, {
      headers: poeHeaders(apiKey),
      maxRetries: 2,
      retryDelay: 1000,
    });

    if (!response.ok) {
      // 401/403/4xx — auth or request errors. No cache fallback: a stale
      // snapshot cannot confirm whether the credential is still valid.
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Invalid response from provider',
      });
    }

    const usage = transformQuota(payload ?? {});

    const result = buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage,
      accountKey: accountKey ?? undefined,
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