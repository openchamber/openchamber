/**
 * BytePlus quota provider
 *
 * Cookie-based manual-auth provider for the BytePlus Ark Coding Plan.
 * Credentials are stored via the credential registry (`getCredential`)
 * and API calls go through `fetchWithRetry` for timeout, retry, and
 * backoff handling.
 *
 * Canonical endpoint (ported from mystatus plugin):
 *   POST https://console.byteplus.com/api/top/ark/ap-southeast-1/2024-01-01/GetCodingPlanUsage
 *
 * Auth shape (from credentials/schemas.js):
 *   - `cookie` (required): must contain `csrfToken=`
 *
 * The `csrfToken` value is extracted from the cookie string and sent
 * back as the `X-Csrf-Token` header (canonical CSRF double-submit).
 *
 * Canonical response shape:
 *   {
 *     ResponseMetadata: { RequestId, Action, Error? },
 *     Result: {
 *       Status: string,
 *       UpdateTimestamp: number,        // unix seconds
 *       QuotaUsage: Array<{
 *         Level: string,                // "session" | "weekly" | "monthly"
 *         Percent: number,              // 0-100 USED
 *         ResetTimestamp: number,       // unix seconds
 *       }>
 *     }
 *   }
 *
 * On retryable failures (429/5xx after retry exhaustion, network
 * errors, timeouts) the provider falls back to the last successful
 * result marked `isStale: true`. Auth failures (401/403) and parse
 * errors do NOT trigger cache fallback — a stale snapshot cannot
 * confirm whether the credential is still valid.
 *
 * Cookies and JWTs are never included in error messages.
 *
 * @module quota/providers/byteplus
 */

import { getCredential } from '../credentials/store.js';
import {
  fetchWithRetry,
  buildResult,
  toUsageWindow,
  toTimestamp,
} from '../utils/index.js';

export const providerId = 'byteplus';
export const providerName = 'BytePlus';

const BYTEPLUS_API_URL =
  'https://console.byteplus.com/api/top/ark/ap-southeast-1/2024-01-01/GetCodingPlanUsage';

/**
 * Canonical sort order for QuotaUsage windows: session first, then
 * weekly, then monthly. Unknown levels sort last (stable by index).
 */
const LEVEL_SORT_ORDER = { session: 0, weekly: 1, monthly: 2 };

/**
 * In-memory cache of the last successful result, keyed by accountHint.
 * Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Resolve the cookie from the credential store.
 *
 * @returns {{ cookie: string|null, accountKey: string|null }}
 */
function resolveCredential() {
  const record = getCredential(providerId);
  if (!record?.credential) return { cookie: null, accountKey: null };
  const cookie = typeof record.credential.cookie === 'string' ? record.credential.cookie : null;
  return { cookie, accountKey: record.accountHint ?? null };
}

/**
 * Extract the `csrfToken` value from a cookie header string.
 *
 * @param {string} cookieHeader
 * @returns {string|null}
 */
function extractCsrfToken(cookieHeader) {
  const match = cookieHeader.match(/csrfToken=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Transform the canonical BytePlus GetCodingPlanUsage payload into
 * OpenChamber usage windows.
 *
 * Mapping (canonical -> OpenChamber):
 *   Result.QuotaUsage[].Level        -> window key (capitalized) + sort order
 *   Result.QuotaUsage[].Percent      -> usedPercent (0-100 used)
 *   Result.QuotaUsage[].ResetTimestamp -> resetAt (unix seconds -> ms via toTimestamp)
 *   remainingPercent                 -> 100 - Percent (computed by toUsageWindow)
 *
 * `ResponseMetadata.Error` and non-success `Result.Status` are treated
 * as provider errors and surfaced via the thrown error path.
 *
 * @param {object} payload - canonical response envelope
 * @returns {object|null} - { windows } or null when no usable quota data
 * @throws {Error} when the envelope carries an application-level error
 */
function transformQuota(payload) {
  const metadata = payload?.ResponseMetadata;
  const envelopeError = metadata?.Error;
  if (envelopeError) {
    const code = envelopeError.Code ?? envelopeError.Message ?? JSON.stringify(envelopeError);
    throw new Error(`BytePlus API error: ${code}`);
  }

  const result = payload?.Result && typeof payload.Result === 'object' ? payload.Result : null;
  if (!result) return null;

  const status = typeof result.Status === 'string' ? result.Status : null;
  if (status && !/running|success|active/i.test(status)) {
    throw new Error(`BytePlus API non-success status: ${status}`);
  }

  const quotaUsage = Array.isArray(result.QuotaUsage) ? result.QuotaUsage : [];
  if (quotaUsage.length === 0) return null;

  const sorted = [...quotaUsage].sort((a, b) => {
    const ai = LEVEL_SORT_ORDER[String(a?.Level).toLowerCase()] ?? 999;
    const bi = LEVEL_SORT_ORDER[String(b?.Level).toLowerCase()] ?? 999;
    return ai - bi;
  });

  const windows = {};
  for (const usage of sorted) {
    const level = usage?.Level;
    const percent = usage?.Percent;
    const resetTs = usage?.ResetTimestamp;

    if (typeof level !== 'string' || typeof percent !== 'number' || typeof resetTs !== 'number') {
      continue; // skip malformed entries
    }

    const label = level.charAt(0).toUpperCase() + level.slice(1);
    const usedPercent = percent;
    const resetAt = toTimestamp(resetTs);

    windows[label] = toUsageWindow({
      usedPercent,
      resetAt,
      sectionHeader: label,
    });
  }

  if (Object.keys(windows).length === 0) return null;
  return { windows };
}

export const isConfigured = () => {
  const { cookie } = resolveCredential();
  return Boolean(cookie && cookie.includes('csrfToken'));
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
  const csrfToken = extractCsrfToken(cookie);
  if (!csrfToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Malformed credential: cookie must contain csrfToken',
    });
  }

  const headers = {
    Cookie: cookie,
    'X-Csrf-Token': csrfToken,
    'Content-Type': 'application/json',
    'User-Agent': 'OpenChamber/1.0',
  };

  try {
    const response = await fetchWithRetry(BYTEPLUS_API_URL, {
      method: 'POST',
      headers,
      body: '{}',
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

    let usage;
    try {
      usage = transformQuota(payload);
    } catch (transformError) {
      // Application-level error envelope or non-success status — not a
      // transient failure, so no stale-cache fallback.
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: transformError instanceof Error ? transformError.message : 'Transform failed',
      });
    }

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