/**
 * Quota history tracking
 *
 * Bounded per-provider history of quota snapshots with trend computation.
 * Stores entries under the OpenChamber data dir (quota/history/).
 *
 * Bounds:
 * - Count: 100 snapshots per provider (FIFO eviction)
 * - Age: 30 days (snapshots older than 30 days are pruned)
 *
 * Trend computation:
 * - `getTrend()` derives a direction ('up', 'down', 'flat', 'unknown')
 *   from the delta between the most recent and the oldest snapshot
 *   in the current window.
 * - Projects a future value via linear extrapolation from the slope
 *   of the recent snapshots.
 *
 * @module quota/history
 */

import fs from 'fs';
import path from 'path';

import { getOpenChamberDataDir } from './utils/credentials-path.js';

const MAX_SNAPSHOTS_PER_PROVIDER = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const HISTORY_DIRNAME = path.join('quota', 'history');

/**
 * In-memory history: Map<providerId, Array<{ result, recordedAt }>>
 */
const historyStore = new Map();
let diskLoaded = false;

/**
 * Resolve the history directory under the OpenChamber data dir.
 *
 * @returns {string}
 */
function getHistoryDir() {
  return path.join(getOpenChamberDataDir(), HISTORY_DIRNAME);
}

/**
 * Resolve the history file path for a provider.
 *
 * @param {string} providerId
 * @returns {string}
 */
function getHistoryFilePath(providerId) {
  const safe = sanitizeProviderId(providerId);
  return path.join(getHistoryDir(), `${safe}.json`);
}

/**
 * Sanitize a providerId for use as a filename.
 *
 * Only allows alphanumerics, dash, underscore, and dot.
 * Anything else is replaced with `_`.
 *
 * @param {string} providerId
 * @returns {string}
 */
function sanitizeProviderId(providerId) {
  if (typeof providerId !== 'string' || !providerId) return 'unknown';
  return providerId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Ensure the history directory exists.
 *
 * @returns {void}
 */
function ensureHistoryDir() {
  const dir = getHistoryDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load history for a provider from disk into memory (once).
 *
 * Missing or corrupt files are treated as empty history.
 *
 * @param {string} providerId
 * @returns {void}
 */
function loadDiskHistory(providerId) {
  if (diskLoaded) return;
  diskLoaded = true;
  // We load lazily per-provider on first access; mark all as loaded after first pass.
  try {
    const filePath = getHistoryFilePath(providerId);
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return;
    const snapshots = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const result = entry.result;
      const recordedAt = typeof entry.recordedAt === 'number' ? entry.recordedAt : null;
      if (!result || recordedAt === null) continue;
      snapshots.push({ result, recordedAt });
    }
    historyStore.set(providerId, snapshots);
    pruneProvider(providerId);
  } catch {
    // Corrupt file: start empty for this provider.
    historyStore.delete(providerId);
  }
}

/**
 * Persist history for a provider to disk atomically.
 *
 * @param {string} providerId
 * @returns {void}
 */
function persistDiskHistory(providerId) {
  try {
    ensureHistoryDir();
    const filePath = getHistoryFilePath(providerId);
    const tmpPath = `${filePath}.tmp`;
    const snapshots = historyStore.get(providerId) ?? [];
    const data = JSON.stringify(snapshots, null, 2);
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Disk persistence is best-effort.
  }
}

/**
 * Prune snapshots for a provider that exceed count or age bounds.
 *
 * @param {string} providerId
 * @returns {void}
 */
function pruneProvider(providerId) {
  const snapshots = historyStore.get(providerId);
  if (!snapshots || snapshots.length === 0) return;

  const cutoff = Date.now() - MAX_AGE_MS;
  const pruned = snapshots.filter((s) => s.recordedAt >= cutoff);
  // Also enforce count bound (keep most recent).
  if (pruned.length > MAX_SNAPSHOTS_PER_PROVIDER) {
    pruned.splice(0, pruned.length - MAX_SNAPSHOTS_PER_PROVIDER);
  }
  if (pruned.length !== snapshots.length) {
    historyStore.set(providerId, pruned);
  }
}

/**
 * Extract a comparable numeric metric from a ProviderResult for trend math.
 *
 * Prefers the lowest `usedPercent` across windows (most constrained window),
 * falling back to `remainingPercent`. Returns `null` when no usable metric.
 *
 * @param {object} result
 * @returns {number|null}
 */
function extractMetric(result) {
  const usage = result?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const windows = usage.windows;
  if (!windows || typeof windows !== 'object') return null;

  let lowestRemaining = null;
  let highestUsed = null;

  for (const window of Object.values(windows)) {
    if (!window || typeof window !== 'object') continue;
    const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? window.usedPercent
      : null;
    const remaining = typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
      ? window.remainingPercent
      : null;

    if (used !== null) {
      if (highestUsed === null || used > highestUsed) highestUsed = used;
    }
    if (remaining !== null) {
      if (lowestRemaining === null || remaining < lowestRemaining) lowestRemaining = remaining;
    }
  }

  // Prefer remaining (lower = more urgent), fall back to used (higher = more urgent).
  if (lowestRemaining !== null) return lowestRemaining;
  if (highestUsed !== null) return 100 - highestUsed;
  return null;
}

/**
 * Record a snapshot of a provider result into history.
 *
 * Appends to the per-provider history, then prunes to bounds and persists.
 * No-op when `providerId` or `result` is missing.
 *
 * @param {string} providerId
 * @param {object} result - ProviderResult to record
 * @returns {void}
 */
export function recordSnapshot(providerId, result) {
  if (!providerId || !result) return;
  loadDiskHistory(providerId);
  const snapshots = historyStore.get(providerId) ?? [];
  snapshots.push({ result, recordedAt: Date.now() });
  historyStore.set(providerId, snapshots);
  pruneProvider(providerId);
  persistDiskHistory(providerId);
}

/**
 * Get recent history snapshots for a provider.
 *
 * Returns the most recent `limit` snapshots (oldest first within that window).
 * Returns an empty array when no history exists.
 *
 * @param {string} providerId
 * @param {number} [limit=100] - max snapshots to return
 * @returns {Array<{ result: object, recordedAt: number }>}
 */
export function getHistory(providerId, limit = MAX_SNAPSHOTS_PER_PROVIDER) {
  if (!providerId) return [];
  loadDiskHistory(providerId);
  pruneProvider(providerId);
  const snapshots = historyStore.get(providerId) ?? [];
  if (snapshots.length === 0) return [];
  const effectiveLimit = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : MAX_SNAPSHOTS_PER_PROVIDER;
  const start = Math.max(0, snapshots.length - effectiveLimit);
  return snapshots.slice(start);
}

/**
 * Compute a trend for a provider from its history.
 *
 * Derives:
 * - `direction`: 'up' | 'down' | 'flat' | 'unknown'
 * - `delta`: numeric change between oldest and most recent metric (or null)
 * - `slope`: per-millisecond slope of the metric (or null)
 * - `projected`: projected metric value at the next interval (or null)
 * - `samples`: number of usable snapshots
 *
 * Direction semantics (metric = remaining quota):
 * - 'up' means remaining quota is increasing (usage decreasing) — healthy
 * - 'down' means remaining quota is decreasing (usage increasing) — concerning
 * - 'flat' means no meaningful change
 * - 'unknown' when insufficient data (< 2 usable samples)
 *
 * @param {string} providerId
 * @returns {{ direction: string, delta: number|null, slope: number|null, projected: number|null, samples: number }}
 */
export function getTrend(providerId) {
  if (!providerId) {
    return { direction: 'unknown', delta: null, slope: null, projected: null, samples: 0 };
  }
  const snapshots = getHistory(providerId);
  if (snapshots.length < 2) {
    return { direction: 'unknown', delta: null, slope: null, projected: null, samples: snapshots.length };
  }

  const points = [];
  for (const snap of snapshots) {
    const metric = extractMetric(snap.result);
    if (metric === null) continue;
    points.push({ t: snap.recordedAt, v: metric });
  }

  if (points.length < 2) {
    return { direction: 'unknown', delta: null, slope: null, projected: null, samples: points.length };
  }

  const first = points[0];
  const last = points[points.length - 1];
  const delta = last.v - first.v;
  const dt = last.t - first.t;
  const slope = dt > 0 ? delta / dt : null;

  // Project forward by the average interval between samples.
  let projected = null;
  if (slope !== null && points.length >= 2) {
    let totalInterval = 0;
    for (let i = 1; i < points.length; i++) {
      totalInterval += points[i].t - points[i - 1].t;
    }
    const avgInterval = totalInterval / (points.length - 1);
    projected = last.v + slope * avgInterval;
  }

  // Direction: use a small epsilon relative to the metric range to avoid noise.
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const epsilon = Math.max(1, range * 0.05);

  let direction = 'flat';
  if (delta > epsilon) direction = 'up';
  else if (delta < -epsilon) direction = 'down';

  return { direction, delta, slope, projected, samples: points.length };
}

/**
 * Clear history for a provider (in-memory and disk).
 *
 * @param {string} providerId
 * @returns {void}
 */
export function clearHistory(providerId) {
  if (!providerId) return;
  historyStore.delete(providerId);
  try {
    const filePath = getHistoryFilePath(providerId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Reset internal state. Intended for tests only.
 *
 * @returns {void}
 */
export function _resetForTest() {
  historyStore.clear();
  diskLoaded = false;
}

export const _bounds = { MAX_SNAPSHOTS_PER_PROVIDER, MAX_AGE_MS };