import { isPersistedCacheEntry, readDiskCache, writeDiskCache } from './disk-cache.js';
import type { PersistedCacheEntry } from './disk-cache.js';
import type { SkillsScanResult } from './scan.js';

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const DISK_CACHE_FILE = 'skills-catalog-cache.json';
const MAX_CONCURRENT_SCANS = 2;

const cache = new Map<string, PersistedCacheEntry>();
const inFlight = new Map<string, Promise<object>>();

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
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCachedScan(key: string, value: SkillsScanResult, ttlMs = DEFAULT_TTL_MS) {
  const ttl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS;
  cache.set(key, { expiresAt: Date.now() + ttl, value });
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
