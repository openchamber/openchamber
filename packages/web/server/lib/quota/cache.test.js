import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  getCachedResult,
  setCachedResult,
  isCacheStale,
  clearCache,
  _resetForTest,
  _bounds
} from './cache.js';

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cache-test-'));
}

const sampleResult = (overrides = {}) => ({
  providerId: 'claude',
  providerName: 'Claude',
  ok: true,
  configured: true,
  usage: { windows: { '5h': { usedPercent: 60, remainingPercent: 40 } } },
  fetchedAt: Date.now(),
  ...overrides
});

describe('cache', () => {
  let originalDataDir;
  let tempDir;

  beforeEach(() => {
    originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
    tempDir = createTempDataDir();
    process.env.OPENCHAMBER_DATA_DIR = tempDir;
    _resetForTest();
  });

  afterEach(() => {
    process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getCachedResult', () => {
    it('returns null on cache miss', () => {
      expect(getCachedResult('claude')).toBeNull();
    });

    it('returns null for empty providerId', () => {
      expect(getCachedResult('')).toBeNull();
      expect(getCachedResult(null)).toBeNull();
    });

    it('returns cached result with isStale false when fresh', () => {
      const result = sampleResult();
      setCachedResult('claude', result);
      const cached = getCachedResult('claude');
      expect(cached).not.toBeNull();
      expect(cached.providerId).toBe('claude');
      expect(cached.isStale).toBe(false);
    });

    it('returns cached result with isStale true when older than maxAge', () => {
      const cacheDir = path.join(tempDir, 'quota', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const oldTime = Date.now() - 60000;
      const entry = { claude: { result: sampleResult(), storedAt: oldTime, bytes: 100 } };
      fs.writeFileSync(path.join(cacheDir, 'cache.json'), JSON.stringify(entry, null, 2));
      _resetForTest();
      const cached = getCachedResult('claude', 30_000);
      expect(cached).not.toBeNull();
      expect(cached.isStale).toBe(true);
    });

    it('does not mutate the original result', () => {
      const result = sampleResult();
      setCachedResult('claude', result);
      getCachedResult('claude');
      expect(result.isStale).toBeUndefined();
    });
  });

  describe('setCachedResult', () => {
    it('stores a result that can be retrieved', () => {
      setCachedResult('codex', sampleResult({ providerId: 'codex' }));
      const cached = getCachedResult('codex');
      expect(cached).not.toBeNull();
      expect(cached.providerId).toBe('codex');
    });

    it('overwrites an existing entry', () => {
      setCachedResult('claude', sampleResult({ ok: false }));
      setCachedResult('claude', sampleResult({ ok: true }));
      const cached = getCachedResult('claude');
      expect(cached.ok).toBe(true);
    });

    it('is a no-op for missing providerId or result', () => {
      setCachedResult('', sampleResult());
      setCachedResult('claude', null);
      expect(getCachedResult('claude')).toBeNull();
    });

    it('persists to disk under quota/cache/', () => {
      setCachedResult('claude', sampleResult());
      const cacheFile = path.join(tempDir, 'quota', 'cache', 'cache.json');
      expect(fs.existsSync(cacheFile)).toBe(true);
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.claude).toBeDefined();
      expect(parsed.claude.result.providerId).toBe('claude');
    });

    it('loads from disk on subsequent access', () => {
      setCachedResult('claude', sampleResult());
      // Reset memory to force disk load.
      _resetForTest();
      const cached = getCachedResult('claude');
      expect(cached).not.toBeNull();
      expect(cached.providerId).toBe('claude');
    });
  });

  describe('isCacheStale', () => {
    it('returns null on cache miss', () => {
      expect(isCacheStale('claude')).toBeNull();
    });

    it('returns false when fresh', () => {
      setCachedResult('claude', sampleResult());
      expect(isCacheStale('claude', 60_000)).toBe(false);
    });

    it('returns true when older than maxAge', () => {
      // Manually write an old entry to disk, then load it.
      const cacheDir = path.join(tempDir, 'quota', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const oldTime = Date.now() - 60000;
      const entry = { claude: { result: sampleResult(), storedAt: oldTime, bytes: 100 } };
      fs.writeFileSync(path.join(cacheDir, 'cache.json'), JSON.stringify(entry, null, 2));
      _resetForTest();
      expect(isCacheStale('claude', 30_000)).toBe(true);
    });

    it('returns false when maxAge is non-positive', () => {
      setCachedResult('claude', sampleResult());
      expect(isCacheStale('claude', -1)).toBe(false);
      expect(isCacheStale('claude', 0)).toBe(false);
    });

    it('returns null for empty providerId', () => {
      expect(isCacheStale('')).toBeNull();
      expect(isCacheStale(null)).toBeNull();
    });
  });

  describe('bounds enforcement', () => {
    it('evicts oldest entries when count exceeds MAX_ENTRIES', () => {
      const { MAX_ENTRIES } = _bounds;
      for (let i = 0; i < MAX_ENTRIES + 5; i++) {
        setCachedResult(`provider-${i}`, sampleResult({ providerId: `provider-${i}` }));
      }
      // The first 5 should have been evicted.
      for (let i = 0; i < 5; i++) {
        expect(getCachedResult(`provider-${i}`)).toBeNull();
      }
      // The most recent MAX_ENTRIES should still be present.
      for (let i = 5; i < MAX_ENTRIES + 5; i++) {
        expect(getCachedResult(`provider-${i}`)).not.toBeNull();
      }
    });

    it('evicts oldest entries when byte size exceeds MAX_BYTES', () => {
      // Create large results that exceed 5MB when combined.
      const bigPayload = 'x'.repeat(1024 * 1024); // 1MB string
      for (let i = 0; i < 10; i++) {
        setCachedResult(`big-${i}`, sampleResult({
          providerId: `big-${i}`,
          usage: { windows: {}, big: bigPayload }
        }));
      }
      // Not all 10 should fit; the earliest should be evicted.
      expect(getCachedResult('big-0')).toBeNull();
      // The latest should still be present.
      expect(getCachedResult('big-9')).not.toBeNull();
    });
  });

  describe('clearCache', () => {
    it('removes all entries from memory and disk', () => {
      setCachedResult('claude', sampleResult());
      clearCache();
      expect(getCachedResult('claude')).toBeNull();
      const cacheFile = path.join(tempDir, 'quota', 'cache', 'cache.json');
      expect(fs.existsSync(cacheFile)).toBe(false);
    });
  });

  describe('corrupt disk cache', () => {
    it('starts empty when disk file is corrupt', () => {
      const cacheDir = path.join(tempDir, 'quota', 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'cache.json'), '{ not valid json');
      _resetForTest();
      expect(getCachedResult('claude')).toBeNull();
    });
  });
});