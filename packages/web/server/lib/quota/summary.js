/**
 * Quota summary and sorting
 *
 * Aggregates provider results into summary stats and provides sorting
 * helpers for UI presentation.
 *
 * @module quota/summary
 */

const DEFAULT_LOW_QUOTA_THRESHOLD = 20; // percent remaining

/**
 * Collect every windows map on a result: the top-level `usage.windows` plus
 * each `usage.accounts[].windows`. Skips missing/non-object maps. Returns []
 * when usage is absent.
 *
 * @param {object} usage
 * @returns {object[]} - array of windows maps (each a Record<string, UsageWindow>)
 */
function collectWindowsMaps(usage) {
  if (!usage || typeof usage !== 'object') return [];
  const maps = [];
  if (usage.windows && typeof usage.windows === 'object') maps.push(usage.windows);
  const accounts = usage.accounts;
  if (Array.isArray(accounts)) {
    for (const acct of accounts) {
      if (!acct || typeof acct !== 'object') continue;
      const w = acct.windows;
      if (w && typeof w === 'object') maps.push(w);
    }
  }
  return maps;
}

/**
 * Extract the lowest remaining percent across all windows of a result,
 * including per-account windows for multi-account providers.
 *
 * Returns `null` when the result has no usable windows.
 *
 * @param {object} result - ProviderResult
 * @returns {number|null} - lowest remaining percent (0-100), or null
 */
export function getLowestRemaining(result) {
  const usage = result?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const maps = collectWindowsMaps(usage);
  if (maps.length === 0) return null;

  let lowest = null;
  for (const windows of maps) {
    for (const window of Object.values(windows)) {
      if (!window || typeof window !== 'object') continue;
      const remaining = typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
        ? window.remainingPercent
        : null;
      if (remaining === null) continue;
      if (lowest === null || remaining < lowest) lowest = remaining;
    }
  }
  return lowest;
}

/**
 * Extract the soonest reset timestamp across all windows of a result,
 * including per-account windows for multi-account providers.
 *
 * Returns `null` when the result has no usable reset timestamps.
 *
 * @param {object} result - ProviderResult
 * @returns {number|null} - soonest reset epoch ms, or null
 */
export function getSoonestReset(result) {
  const usage = result?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const maps = collectWindowsMaps(usage);
  if (maps.length === 0) return null;

  let soonest = null;
  for (const windows of maps) {
    for (const window of Object.values(windows)) {
      if (!window || typeof window !== 'object') continue;
      const resetAt = window.resetAt;
      if (resetAt === null || resetAt === undefined || resetAt === '') continue;
      const ts = typeof resetAt === 'number'
        ? (resetAt < 1_000_000_000_000 ? resetAt * 1000 : resetAt)
        : (() => {
            const parsed = Date.parse(resetAt);
            return Number.isNaN(parsed) ? null : parsed;
          })();
      if (ts === null || !Number.isFinite(ts)) continue;
      // Only consider future resets for "soonest".
      if (ts < Date.now()) continue;
      if (soonest === null || ts < soonest) soonest = ts;
    }
  }
  return soonest;
}

/**
 * Build a summary of aggregated provider results.
 *
 * Returns:
 * - `totalProviders`: count of all results
 * - `okProviders`: count of results with `ok: true`
 * - `configuredProviders`: count of results with `configured: true`
 * - `lowestRemaining`: the lowest remaining percent across all providers (or null)
 * - `soonestReset`: the soonest reset timestamp across all providers (or null)
 * - `lowQuotaCount`: count of providers below the low-quota threshold
 *
 * @param {object[]} results - array of ProviderResult
 * @param {object} [options]
 * @param {number} [options.lowQuotaThreshold=20] - remaining percent below which a provider is "low"
 * @returns {object}
 */
export function buildSummary(results, options = {}) {
  const list = Array.isArray(results) ? results : [];
  const threshold = typeof options?.lowQuotaThreshold === 'number' && Number.isFinite(options.lowQuotaThreshold)
    ? options.lowQuotaThreshold
    : DEFAULT_LOW_QUOTA_THRESHOLD;

  let totalProviders = list.length;
  let okProviders = 0;
  let configuredProviders = 0;
  let lowestRemaining = null;
  let soonestReset = null;
  let lowQuotaCount = 0;

  for (const result of list) {
    if (!result || typeof result !== 'object') continue;
    if (result.ok) okProviders += 1;
    if (result.configured) configuredProviders += 1;

    const remaining = getLowestRemaining(result);
    if (remaining !== null) {
      if (lowestRemaining === null || remaining < lowestRemaining) lowestRemaining = remaining;
      if (remaining < threshold) lowQuotaCount += 1;
    }

    const reset = getSoonestReset(result);
    if (reset !== null) {
      if (soonestReset === null || reset < soonestReset) soonestReset = reset;
    }
  }

  return {
    totalProviders,
    okProviders,
    configuredProviders,
    lowestRemaining,
    soonestReset,
    lowQuotaCount,
    lowQuotaThreshold: threshold
  };
}

/**
 * Sort provider results by a given criterion.
 *
 * Supported `sortBy` values:
 * - `'urgency'`: lowest remaining percent first (most urgent). Providers
 *   with no remaining data sort last.
 * - `'name'`: alphabetical by `providerName` (case-insensitive).
 * - `'reset'`: soonest reset first. Providers with no reset sort last.
 *
 * Defaults to `'urgency'` for unknown values.
 *
 * @param {object[]} results - array of ProviderResult
 * @param {string} [sortBy='urgency']
 * @returns {object[]} - new sorted array (does not mutate input)
 */
export function sortProviders(results, sortBy = 'urgency') {
  const list = Array.isArray(results) ? [...results] : [];

  if (sortBy === 'name') {
    return list.sort((a, b) => {
      const nameA = String(a?.providerName ?? '').toLowerCase();
      const nameB = String(b?.providerName ?? '').toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });
  }

  if (sortBy === 'reset') {
    return list.sort((a, b) => {
      const resetA = getSoonestReset(a);
      const resetB = getSoonestReset(b);
      // null sorts last.
      if (resetA === null && resetB === null) return 0;
      if (resetA === null) return 1;
      if (resetB === null) return -1;
      return resetA - resetB;
    });
  }

  // Default: urgency (lowest remaining first).
  return list.sort((a, b) => {
    const remA = getLowestRemaining(a);
    const remB = getLowestRemaining(b);
    // null sorts last.
    if (remA === null && remB === null) return 0;
    if (remA === null) return 1;
    if (remB === null) return -1;
    return remA - remB;
  });
}

/**
 * Return providers whose lowest remaining percent is below a threshold.
 *
 * Providers with no usable remaining data are excluded (not treated as low).
 *
 * @param {object[]} results - array of ProviderResult
 * @param {number} [threshold=20] - remaining percent threshold
 * @returns {object[]} - results below the threshold, sorted by urgency
 */
export function getLowQuotaProviders(results, threshold = DEFAULT_LOW_QUOTA_THRESHOLD) {
  const list = Array.isArray(results) ? results : [];
  const effectiveThreshold = typeof threshold === 'number' && Number.isFinite(threshold)
    ? threshold
    : DEFAULT_LOW_QUOTA_THRESHOLD;

  const low = list.filter((result) => {
    const remaining = getLowestRemaining(result);
    return remaining !== null && remaining < effectiveThreshold;
  });

  return sortProviders(low, 'urgency');
}

export const _defaults = { DEFAULT_LOW_QUOTA_THRESHOLD };