import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearCache, scanWithCache, setCachedScan, getCachedScan, getScanCacheSize, pruneExpiredScans, MAX_CACHED_SCANS } from './cache.js';

let tempDataDir;

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-cache-test-'));
  process.env.OPENCHAMBER_DATA_DIR = tempDataDir;
});

afterEach(() => {
  delete process.env.OPENCHAMBER_DATA_DIR;
  clearCache();
  vi.restoreAllMocks();
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

const flushDiskWrites = async () => new Promise((resolve) => setTimeout(resolve, 1200));

describe('scanWithCache', () => {
  it('deduplicates concurrent loaders for the same key', async () => {
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, items: [] };
    });

    const [a, b] = await Promise.all([
      scanWithCache('k', loader),
      scanWithCache('k', loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('limits concurrent scans across different keys', async () => {
    let running = 0;
    let peak = 0;
    const loader = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { ok: true, items: [] };
    };

    await Promise.all(Array.from({ length: 6 }, (_, i) => scanWithCache(`key-${i}`, loader)));

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('does not cache failed scans', async () => {
    await scanWithCache('bad', async () => ({ ok: false, error: { kind: 'networkError', message: 'x' } }));

    expect(getCachedScan('bad')).toBeNull();
  });

  it('refresh bypasses the cache', async () => {
    setCachedScan('fresh', { ok: true, items: ['cached'] });

    const result = await scanWithCache('fresh', async () => ({ ok: true, items: ['reloaded'] }), { refresh: true });

    expect(result.items).toEqual(['reloaded']);
    expect(getCachedScan('fresh').items).toEqual(['reloaded']);
  });

  it('persists successful scans to disk for later processes', async () => {
    await scanWithCache('persisted', async () => ({ ok: true, items: [{ skillName: 'x' }] }));
    await flushDiskWrites();

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'skills-catalog-cache.json'), 'utf8'));
    expect(onDisk.persisted.value.items).toEqual([{ skillName: 'x' }]);
  });

  it('returns live entries within TTL', () => {
    setCachedScan('live', { ok: true, items: [1] });
    expect(getCachedScan('live')).toEqual({ ok: true, items: [1] });
  });
});

describe('scan cache eviction', () => {
  it('sweeps expired entries without re-reading the same key', async () => {
    setCachedScan('expired-a', { ok: true, items: ['stale'] }, 20);
    setCachedScan('live-b', { ok: true, items: ['fresh'] });
    expect(getScanCacheSize()).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Accessing a different live key sweeps all expired entries.
    expect(getCachedScan('live-b')).toEqual({ ok: true, items: ['fresh'] });
    expect(getScanCacheSize()).toBe(1);
    expect(getCachedScan('expired-a')).toBeNull();
    expect(pruneExpiredScans()).toBe(1);
  });

  it('inserting a new entry sweeps expired entries for never-re-read keys', async () => {
    setCachedScan('expired-a', { ok: true, items: ['stale'] }, 20);
    setCachedScan('expired-b', { ok: true, items: ['stale'] }, 20);
    expect(getScanCacheSize()).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 50));

    setCachedScan('live-c', { ok: true, items: ['fresh'] });
    expect(getScanCacheSize()).toBe(1);
    expect(getCachedScan('live-c')).toEqual({ ok: true, items: ['fresh'] });
  });

  it('keeps disk-persisted entries in agreement with in-memory expiry', async () => {
    setCachedScan('expired-a', { ok: true, items: ['stale'] }, 20);
    setCachedScan('live-b', { ok: true, items: ['fresh'] });

    await new Promise((resolve) => setTimeout(resolve, 50));

    setCachedScan('live-c', { ok: true, items: ['fresh'] });
    await flushDiskWrites();

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'skills-catalog-cache.json'), 'utf8'));
    expect(onDisk['expired-a']).toBeUndefined();
    expect(onDisk['live-b'].value.items).toEqual(['fresh']);
    expect(onDisk['live-c'].value.items).toEqual(['fresh']);
  });

  it('enforces a max-entries bound with oldest-first eviction', () => {
    for (let i = 0; i < MAX_CACHED_SCANS + 10; i += 1) {
      setCachedScan(`key-${i}`, { ok: true, items: [i] });
    }

    expect(getScanCacheSize()).toBe(MAX_CACHED_SCANS);
    expect(getCachedScan('key-0')).toBeNull();
    expect(getCachedScan(`key-${MAX_CACHED_SCANS + 9}`)).toEqual({
      ok: true,
      items: [MAX_CACHED_SCANS + 9],
    });
  });
});
