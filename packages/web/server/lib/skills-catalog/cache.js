import { readDiskCache, writeDiskCache } from './disk-cache.js';

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const DISK_CACHE_FILE = 'skills-catalog-cache.json';
const MAX_CONCURRENT_SCANS = 2;

const cache = new Map();
const inFlight = new Map();

let diskLoaded = false;
let diskWriteTimer = null;

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
      entry
      && typeof entry === 'object'
      && typeof entry.expiresAt === 'number'
      && entry.expiresAt > now
      && entry.value
      && typeof entry.value === 'object'
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
    const persisted = {};
    for (const [key, entry] of cache.entries()) {
      if (entry.expiresAt > now) {
        persisted[key] = entry;
      }
    }
    writeDiskCache(DISK_CACHE_FILE, persisted);
  }, 1000);
  if (typeof diskWriteTimer.unref === 'function') {
    diskWriteTimer.unref();
  }
};

export function getCacheKey({ normalizedRepo, subpath, identityId }) {
  const safeRepo = String(normalizedRepo || '').trim();
  const safeSubpath = String(subpath || '').trim();
  const safeIdentity = String(identityId || '').trim();
  return `${safeRepo}::${safeSubpath}::${safeIdentity}`;
}

export function getCachedScan(key) {
  loadDiskEntries();
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCachedScan(key, value, ttlMs = DEFAULT_TTL_MS) {
  const ttl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS;
  cache.set(key, { expiresAt: Date.now() + ttl, value });
  scheduleDiskWrite();
}

export function clearCache() {
  cache.clear();
  inFlight.clear();
}

// ─── Concurrency-limited scan orchestration ───

let activeScans = 0;
const scanQueue = [];

const acquireScanSlot = () => new Promise((resolve) => {
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
    activeScans += 1;
    resolve();
  }
};

/**
 * Run `loader` for a scan cache key with deduplication and a global
 * concurrency limit. Concurrent callers for the same key share one loader
 * run; at most MAX_CONCURRENT_SCANS loaders run at once. Only successful
 * (`ok: true`) results are cached.
 */
export async function scanWithCache(key, loader, { refresh = false } = {}) {
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
