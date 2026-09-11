import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearCache, scanWithCache, setCachedScan, getCachedScan } from './cache.js';

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
});
