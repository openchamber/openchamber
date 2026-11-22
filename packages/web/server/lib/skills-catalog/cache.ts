import { isPersistedCacheEntry, readDiskCache, writeDiskCache } from './disk-cache.js';
import type { PersistedCacheEntry } from './disk-cache.js';
import type { SkillsScanResult } from './scan.js';

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const DISK_CACHE_FILE = 'skills-catalog-cache.json';
const MAX_CONCURRENT_SCANS = 2;
// Bound on distinct keys with a scan queued or in flight. The active-scan
// limit alone left the pending side unbounded: a burst of distinct source
// scans parked one inFlight entry and one queue waiter per key until each
// settled (issue #2269: 10,000 unique keys, ~10.7 MB heap growth). Requests
// past the cap get the typed busy result below instead of a waiter.
export const MAX_PENDING_SCANS = 32;

const busyScanResult = () => ({
  ok: false as const,
  error: {
    kind: 'busy' as const,
    message: `Skills catalog is busy: ${MAX_PENDING_SCANS} scans already pending; retry shortly`,
  },
});
// Bound in-memory retention: scan values are large (~57 KB each), so an
// unbounded Map retains every catalog ever scanned for process life.
export const MAX_CACHED_SCANS = 100;

const cache = new Map<string, PersistedCacheEntry>();
const inFlight = new Map<string, Promise<object>>();

/** Remove expired entries so they do not accumulate until re-read. */
export function pruneExpiredScans(now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (!entry || now >= entry.expiresAt) {
      cache.delete(key);
    }
  }
  return cache.size;
}

/** Raw entry count for tests (no implicit prune). */
export function getScanCacheSize() {
  return cache.size;
}

let diskLoaded = false;
let diskWriteTimer: ReturnType<typeof setTimeout> | null = null;

const loadDiskEntries = () => {
  if (diskLoaded) {
    return;
  }
  diskLoaded = true;
  const persisted = readDiskCache(DISK_CACHE_FILE);
  if (!persisted) {
    return;
  }
  const now = Date.now();
  for (const [key, entry] of Object.entries(persisted)) {
    if (
      isPersistedCacheEntry(entry)
      && entry.expiresAt > now
    ) {
      cache.set(key, entry);
    }
  }
};

const scheduleDiskWrite = () => {
  if (diskWriteTimer) {
    return;
  }
  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    const now = Date.now();
    const persisted: Record<string, PersistedCacheEntry> = {};
    for (const [key, entry] of cache.entries()) {
      if (entry.expiresAt > now) {
        persisted[key] = entry;
      }
    }
    writeDiskCache(DISK_CACHE_FILE, persisted);
  }, 1000);
  diskWriteTimer.unref();
};

export function getCacheKey({ normalizedRepo, ref, subpath, identityId }: {
  normalizedRepo: string;
  ref?: string | null;
  subpath?: string | null;
  identityId?: string | null;
}) {
  const safeRepo = `${String(normalizedRepo || '').trim()}${ref ? `#${ref}` : ''}`;
  const safeSubpath = String(subpath || '').trim();
  const safeIdentity = String(identityId || '').trim();
  return `${safeRepo}::${safeSubpath}::${safeIdentity}`;
}

export function getCachedScan(key: string) {
  loadDiskEntries();
  pruneExpiredScans();
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU order so the size bound evicts the least-recently-used key.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

export function setCachedScan(key: string, value: SkillsScanResult, ttlMs = DEFAULT_TTL_MS) {
  pruneExpiredScans();
  const ttl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS;
  cache.delete(key);
  cache.set(key, { expiresAt: Date.now() + ttl, value });
  while (cache.size > MAX_CACHED_SCANS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  scheduleDiskWrite();
}

export function clearCache() {
  cache.clear();
  inFlight.clear();
}

let activeScans = 0;
const scanQueue: Array<() => void> = [];

const acquireScanSlot = () => new Promise<void>((resolve) => {
  scanQueue.push(resolve);
  pumpScanQueue();
});

const releaseScanSlot = () => {
  activeScans -= 1;
  pumpScanQueue();
};

const pumpScanQueue = () => {
  while (activeScans < MAX_CONCURRENT_SCANS && scanQueue.length > 0) {
    const resolve = scanQueue.shift();
    if (!resolve) break;
    activeScans += 1;
    resolve();
  }
};

/**
 * Run `loader` for a scan cache key with deduplication and a global
 * concurrency limit. Concurrent callers for the same key share one loader
 * run; at most MAX_CONCURRENT_SCANS loaders run at once and at most
 * MAX_PENDING_SCANS distinct keys may be queued or in flight — a new key
 * past that cap resolves with the typed busy result (`error.kind: 'busy'`)
 * instead of waiting. Only successful (`ok: true`) results are cached.
 */
export async function scanWithCache(key: string, loader: () => Promise<SkillsScanResult>, { refresh = false } = {}) {
  if (!refresh) {
    const cached = getCachedScan(key);
    if (cached) {
      return cached;
    }
  }

  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  // Same-key callers coalesce above; a NEW key past the pending cap is
  // refused with the typed busy result rather than queued without bound.
  // The refusal is not cached and holds no slot, so it drains instantly.
  if (inFlight.size >= MAX_PENDING_SCANS) {
    return busyScanResult();
  }

  const run = (async () => {
    await acquireScanSlot();
    try {
      const result = await loader();
      if (result && result.ok) {
        setCachedScan(key, result);
      }
      return result;
    } finally {
      releaseScanSlot();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}
