/**
 * Quota result cache
 *
 * Bounded in-memory + disk cache for provider quota results.
 * Stores entries under the OpenChamber data dir (quota/cache/).
 *
 * Bounds:
 * - Count: 50 entries (LRU eviction when exceeded)
 * - Byte size: 5MB total (evicts oldest entries when exceeded)
 *
 * Stale markers:
 * - `getCachedResult()` returns the cached result with `isStale: true`
 *   when the entry is older than `maxAgeMs` (default 5 minutes).
 * - Fresh entries return `isStale: false`.
 * - Cache misses return `null` (never fabricate a fresh-looking result).
 *
 * @module quota/cache
 */

import fs from 'fs';
import path from 'path';

import { getOpenChamberDataDir } from './utils/credentials-path.js';

const MAX_ENTRIES = 50;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

const CACHE_DIRNAME = path.join('quota', 'cache');
const CACHE_FILENAME = 'cache.json';

/**
 * In-memory cache: Map<providerId, { result, storedAt, bytes }>
 * Insertion order is LRU (oldest entries first via Map iteration order).
 */
const memoryCache = new Map();
let diskLoaded = false;

/**
 * Resolve the cache directory under the OpenChamber data dir.
 *
 * @returns {string}
 */
function getCacheDir() {
  return path.join(getOpenChamberDataDir(), CACHE_DIRNAME);
}

/**
 * Resolve the cache JSON file path.
 *
 * @returns {string}
 */
function getCacheFilePath() {
  return path.join(getCacheDir(), CACHE_FILENAME);
}

/**
 * Ensure the cache directory exists.
 *
 * @returns {void}
 */
function ensureCacheDir() {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Approximate byte size of a JSON-serializable value.
 *
 * @param {*} value
 * @returns {number}
 */
function approxBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Load the disk cache into the in-memory map (once).
 *
 * Missing or corrupt files are treated as an empty cache.
 *
 * @returns {void}
 */
function loadDiskCache() {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const filePath = getCacheFilePath();
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [providerId, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      const result = entry.result;
      const storedAt = typeof entry.storedAt === 'number' ? entry.storedAt : null;
      if (!result || storedAt === null) continue;
      const bytes = typeof entry.bytes === 'number' ? entry.bytes : approxBytes(result);
      memoryCache.set(providerId, { result, storedAt, bytes });
    }
    enforceBounds();
  } catch {
    // Corrupt cache: start empty.
    memoryCache.clear();
  }
}

/**
 * Persist the in-memory cache to disk atomically.
 *
 * @returns {void}
 */
function persistDiskCache() {
  try {
    ensureCacheDir();
    const filePath = getCacheFilePath();
    const tmpPath = `${filePath}.tmp`;
    const entries = {};
    for (const [providerId, entry] of memoryCache.entries()) {
      entries[providerId] = {
        result: entry.result,
        storedAt: entry.storedAt,
        bytes: entry.bytes
      };
    }
    const data = JSON.stringify(entries, null, 2);
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Disk persistence is best-effort; in-memory cache remains authoritative.
  }
}

/**
 * Enforce count and byte-size bounds by evicting oldest entries.
 *
 * @returns {void}
 */
function enforceBounds() {
  // Count bound: evict oldest until under MAX_ENTRIES.
  while (memoryCache.size > MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    memoryCache.delete(oldestKey);
  }

  // Byte bound: evict oldest until total bytes under MAX_BYTES.
  let totalBytes = 0;
  for (const entry of memoryCache.values()) {
    totalBytes += entry.bytes;
  }
  while (totalBytes > MAX_BYTES && memoryCache.size > 0) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = memoryCache.get(oldestKey);
    memoryCache.delete(oldestKey);
    if (entry) totalBytes -= entry.bytes;
  }
}

/**
 * Get a cached provider result.
 *
 * Returns `null` on cache miss (never fabricates a fresh-looking result).
 * On hit, returns the cached result with an `isStale` marker:
 * - `isStale: true` when the entry is older than `maxAgeMs`
 * - `isStale: false` when the entry is fresh
 *
 * @param {string} providerId
 * @param {number} [maxAgeMs=300000] - max age before stale, in milliseconds
 * @returns {object|null} - cached result with `isStale` marker, or null on miss
 */
export function getCachedResult(providerId, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!providerId) return null;
  loadDiskCache();
  const entry = memoryCache.get(providerId);
  if (!entry) return null;

  // LRU touch: move to end (most recent).
  memoryCache.delete(providerId);
  memoryCache.set(providerId, entry);

  const age = Date.now() - entry.storedAt;
  const isStale = age > maxAgeMs;
  return { ...entry.result, isStale };
}

/**
 * Store a provider result in the cache.
 *
 * Overwrites any existing entry for the same providerId.
 * Enforces count and byte-size bounds after insertion.
 * Persists to disk best-effort.
 *
 * @param {string} providerId
 * @param {object} result - ProviderResult to cache
 * @returns {void}
 */
export function setCachedResult(providerId, result) {
  if (!providerId || !result) return;
  loadDiskCache();
  const bytes = approxBytes(result);
  // LRU: delete first so re-insertion moves to end.
  memoryCache.delete(providerId);
  memoryCache.set(providerId, { result, storedAt: Date.now(), bytes });
  enforceBounds();
  persistDiskCache();
}

/**
 * Check if the cached entry for a provider is stale.
 *
 * Returns `true` when the entry exists and is older than `maxAgeMs`.
 * Returns `false` when the entry is fresh or when `maxAgeMs` is non-positive.
 * Returns `null` on cache miss (no entry to check).
 *
 * @param {string} providerId
 * @param {number} [maxAgeMs=300000] - max age before stale, in milliseconds
 * @returns {boolean|null} - stale=true, fresh=false, miss=null
 */
export function isCacheStale(providerId, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!providerId) return null;
  if (typeof maxAgeMs !== 'number' || maxAgeMs <= 0) return false;
  loadDiskCache();
  const entry = memoryCache.get(providerId);
  if (!entry) return null;
  return Date.now() - entry.storedAt > maxAgeMs;
}

/**
 * Clear the cache (in-memory and disk).
 *
 * @returns {void}
 */
export function clearCache() {
  memoryCache.clear();
  diskLoaded = true;
  try {
    const filePath = getCacheFilePath();
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
  memoryCache.clear();
  diskLoaded = false;
}

export const _bounds = { MAX_ENTRIES, MAX_BYTES, DEFAULT_MAX_AGE_MS };