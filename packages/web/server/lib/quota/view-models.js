/**
 * Quota view-model builders
 *
 * Reusable transforms that turn ProviderResult + history into view models
 * suitable for graphical UI rendering (cards, sparklines, summary).
 *
 * These builders are pure functions: they do not fetch data or touch disk.
 * Callers supply the results and history; the builders shape them for UI.
 *
 * @module quota/view-models
 */

import { getHistory, getTrend } from './history.js';
import {
  buildSummary,
  getLowestRemaining,
  getSoonestReset,
  sortProviders
} from './summary.js';

/**
 * Build a provider card view model from a single ProviderResult.
 *
 * Returns:
 * - `header`: { providerId, providerName, ok, configured, error }
 * - `footer`: { fetchedAt, isStale }
 * - `windows`: array of window view models sorted by urgency (lowest remaining first)
 * - `lowestRemaining`: lowest remaining percent across windows (or null)
 * - `soonestReset`: soonest reset timestamp across windows (or null)
 * - `isLowQuota`: boolean, true when lowestRemaining < threshold
 *
 * @param {object} result - ProviderResult
 * @param {object} [options]
 * @param {number} [options.lowQuotaThreshold=20]
 * @returns {object}
 */
export function buildProviderCard(result, options = {}) {
  const threshold = typeof options?.lowQuotaThreshold === 'number' && Number.isFinite(options.lowQuotaThreshold)
    ? options.lowQuotaThreshold
    : 20;

  if (!result || typeof result !== 'object') {
    return {
      header: { providerId: null, providerName: null, ok: false, configured: false, error: 'Invalid result' },
      footer: { fetchedAt: null, isStale: false },
      windows: [],
      lowestRemaining: null,
      soonestReset: null,
      isLowQuota: false
    };
  }

  const usage = result.usage;
  const windowsObj = usage && typeof usage === 'object' ? usage.windows : null;

  const windowModels = [];
  if (windowsObj && typeof windowsObj === 'object') {
    for (const [key, window] of Object.entries(windowsObj)) {
      if (!window || typeof window !== 'object') continue;
      const remaining = typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
        ? window.remainingPercent
        : null;
      const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
        ? window.usedPercent
        : null;
      windowModels.push({
        key,
        usedPercent: used,
        remainingPercent: remaining,
        windowSeconds: window.windowSeconds ?? null,
        resetAt: window.resetAt ?? null,
        resetAfterSeconds: window.resetAfterSeconds ?? null,
        resetAtFormatted: window.resetAtFormatted ?? null,
        resetAfterFormatted: window.resetAfterFormatted ?? null,
        resetText: window.resetText ?? null,
        valueLabel: window.valueLabel ?? null,
        suffix: window.suffix ?? null,
        detail: Array.isArray(window.detail) ? window.detail : null,
        extra: Array.isArray(window.extra) ? window.extra : null,
        warn: window.warn ?? null,
        sectionHeader: window.sectionHeader ?? null,
        trendKey: window.trendKey ?? null
      });
    }
  }

  // Sort windows by urgency: lowest remaining first, nulls last.
  windowModels.sort((a, b) => {
    if (a.remainingPercent === null && b.remainingPercent === null) return 0;
    if (a.remainingPercent === null) return 1;
    if (b.remainingPercent === null) return -1;
    return a.remainingPercent - b.remainingPercent;
  });

  // Rich usage-level fields are optional passthroughs; absent values
  // normalize to null (or [] for accounts) for a stable view-model shape.
  const usageSubtitle = usage && typeof usage.subtitle === 'string' ? usage.subtitle : null;
  const usageNote = usage && typeof usage.note === 'string' ? usage.note : null;
  const usageHeader = usage && Array.isArray(usage.header) ? usage.header : null;
  const usageFooter = usage && Array.isArray(usage.footer) ? usage.footer : null;
  const accounts = buildAccountsViewModel(usage);

  const lowestRemaining = getLowestRemaining(result);
  const soonestReset = getSoonestReset(result);
  const isLowQuota = lowestRemaining !== null && lowestRemaining < threshold;

  return {
    header: {
      providerId: result.providerId ?? null,
      providerName: result.providerName ?? null,
      ok: Boolean(result.ok),
      configured: Boolean(result.configured),
      error: result.error ?? null
    },
    footer: {
      fetchedAt: result.fetchedAt ?? null,
      isStale: Boolean(result.isStale)
    },
    windows: windowModels,
    lowestRemaining,
    soonestReset,
    isLowQuota,
    usageSubtitle,
    usageNote,
    usageHeader,
    usageFooter,
    accounts
  };
}

/**
 * Build the per-account sub-card view models from a ProviderResult.usage.
 *
 * Each account mirrors the rich usage shape (subtitle/note/header/footer/windows)
 * so providers can emit multi-account cards. Absent accounts normalize to [].
 *
 * @param {object} usage - ProviderResult.usage
 * @returns {object[]}
 */
function buildAccountsViewModel(usage) {
  if (!usage || !Array.isArray(usage.accounts) || usage.accounts.length === 0) {
    return [];
  }
  const out = [];
  for (const acct of usage.accounts) {
    if (!acct || typeof acct !== 'object') continue;
    const windowsObj = acct.windows && typeof acct.windows === 'object' ? acct.windows : null;
    const windows = {};
    if (windowsObj) {
      for (const [key, window] of Object.entries(windowsObj)) {
        if (!window || typeof window !== 'object') continue;
        const remaining = typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
          ? window.remainingPercent
          : null;
        const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
          ? window.usedPercent
          : null;
        windows[key] = {
          usedPercent: used,
          remainingPercent: remaining,
          windowSeconds: window.windowSeconds ?? null,
          resetAt: window.resetAt ?? null,
          resetAfterSeconds: window.resetAfterSeconds ?? null,
          resetAtFormatted: window.resetAtFormatted ?? null,
          resetAfterFormatted: window.resetAfterFormatted ?? null,
          resetText: window.resetText ?? null,
          valueLabel: window.valueLabel ?? null,
          suffix: window.suffix ?? null,
          detail: Array.isArray(window.detail) ? window.detail : null,
          extra: Array.isArray(window.extra) ? window.extra : null,
          warn: window.warn ?? null,
          sectionHeader: window.sectionHeader ?? null,
          trendKey: window.trendKey ?? null
        };
      }
    }
    out.push({
      accountKey: typeof acct.accountKey === 'string' ? acct.accountKey : null,
      label: typeof acct.label === 'string' ? acct.label : null,
      subtitle: typeof acct.subtitle === 'string' ? acct.subtitle : null,
      note: typeof acct.note === 'string' ? acct.note : null,
      header: Array.isArray(acct.header) ? acct.header : null,
      footer: Array.isArray(acct.footer) ? acct.footer : null,
      windows,
      models: acct.models && typeof acct.models === 'object' ? acct.models : null
    });
  }
  return out;
}

/**
 * Build trend sparkline data from a provider's history.
 *
 * Returns:
 * - `points`: array of { t, value } for each usable snapshot (oldest first)
 * - `direction`: trend direction ('up'|'down'|'flat'|'unknown')
 * - `delta`: numeric change between first and last point (or null)
 * - `projected`: projected next value (or null)
 * - `samples`: number of usable points
 *
 * @param {string} providerId
 * @returns {object}
 */
export function buildTrendData(providerId) {
  if (!providerId) {
    return { points: [], direction: 'unknown', delta: null, projected: null, samples: 0 };
  }

  const snapshots = getHistory(providerId);
  const trend = getTrend(providerId);

  const points = [];
  for (const snap of snapshots) {
    const value = extractSparklineMetric(snap.result);
    if (value === null) continue;
    points.push({ t: snap.recordedAt, value });
  }

  return {
    points,
    direction: trend.direction,
    delta: trend.delta,
    projected: trend.projected,
    samples: points.length
  };
}

/**
 * Build a summary card view model from an array of ProviderResults.
 *
 * Returns:
 * - `summary`: the buildSummary() output
 * - `sortedResults`: results sorted by urgency
 * - `lowQuotaProviders`: results below the threshold, sorted by urgency
 *
 * @param {object[]} results - array of ProviderResult
 * @param {object} [options]
 * @param {number} [options.lowQuotaThreshold=20]
 * @param {string} [options.sortBy='urgency']
 * @returns {object}
 */
export function buildSummaryCard(results, options = {}) {
  const list = Array.isArray(results) ? results : [];
  const threshold = typeof options?.lowQuotaThreshold === 'number' && Number.isFinite(options.lowQuotaThreshold)
    ? options.lowQuotaThreshold
    : 20;
  const sortBy = typeof options?.sortBy === 'string' ? options.sortBy : 'urgency';

  const summary = buildSummary(list, { lowQuotaThreshold: threshold });
  const sortedResults = sortProviders(list, sortBy);

  // Reuse summary's lowQuotaCount for consistency; compute the actual list here.
  const lowQuotaProviders = list.filter((result) => {
    const remaining = getLowestRemaining(result);
    return remaining !== null && remaining < threshold;
  });
  const sortedLowQuota = sortProviders(lowQuotaProviders, 'urgency');

  return {
    summary,
    sortedResults,
    lowQuotaProviders: sortedLowQuota
  };
}

/**
 * Extract a numeric metric from a ProviderResult for sparkline rendering.
 *
 * Prefers the lowest remaining percent across windows (most constrained),
 * falling back to `100 - usedPercent` when only used is available.
 *
 * @param {object} result
 * @returns {number|null}
 */
function extractSparklineMetric(result) {
  const usage = result?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const windows = usage.windows;
  if (!windows || typeof windows !== 'object') return null;

  let lowestRemaining = null;
  let highestUsed = null;

  for (const window of Object.values(windows)) {
    if (!window || typeof window !== 'object') continue;
    const remaining = typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
      ? window.remainingPercent
      : null;
    const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? window.usedPercent
      : null;

    if (remaining !== null) {
      if (lowestRemaining === null || remaining < lowestRemaining) lowestRemaining = remaining;
    }
    if (used !== null) {
      if (highestUsed === null || used > highestUsed) highestUsed = used;
    }
  }

  if (lowestRemaining !== null) return lowestRemaining;
  if (highestUsed !== null) return 100 - highestUsed;
  return null;
}