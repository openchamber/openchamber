import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  recordSnapshot,
  getHistory,
  getTrend,
  clearHistory,
  _resetForTest,
  _bounds
} from './history.js';

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-history-test-'));
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

describe('history', () => {
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

  describe('recordSnapshot', () => {
    it('appends a snapshot to history', () => {
      recordSnapshot('claude', sampleResult());
      const history = getHistory('claude');
      expect(history).toHaveLength(1);
      expect(history[0].result.providerId).toBe('claude');
      expect(typeof history[0].recordedAt).toBe('number');
    });

    it('is a no-op for missing providerId or result', () => {
      recordSnapshot('', sampleResult());
      recordSnapshot('claude', null);
      expect(getHistory('claude')).toHaveLength(0);
    });

    it('persists to disk under quota/history/', () => {
      recordSnapshot('claude', sampleResult());
      const historyFile = path.join(tempDir, 'quota', 'history', 'claude.json');
      expect(fs.existsSync(historyFile)).toBe(true);
      const raw = fs.readFileSync(historyFile, 'utf8');
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].result.providerId).toBe('claude');
    });

    it('loads from disk on subsequent access', () => {
      recordSnapshot('claude', sampleResult());
      _resetForTest();
      const history = getHistory('claude');
      expect(history).toHaveLength(1);
      expect(history[0].result.providerId).toBe('claude');
    });
  });

  describe('getHistory', () => {
    it('returns empty array for missing provider', () => {
      expect(getHistory('nonexistent')).toEqual([]);
    });

    it('returns empty array for empty providerId', () => {
      expect(getHistory('')).toEqual([]);
      expect(getHistory(null)).toEqual([]);
    });

    it('returns recent snapshots respecting limit', () => {
      for (let i = 0; i < 10; i++) {
        recordSnapshot('claude', sampleResult({ fetchedAt: i }));
      }
      const limited = getHistory('claude', 3);
      expect(limited).toHaveLength(3);
      // Should be the most recent 3 (oldest first within the window).
      expect(limited[0].result.fetchedAt).toBe(7);
      expect(limited[2].result.fetchedAt).toBe(9);
    });

    it('returns all snapshots when limit exceeds count', () => {
      recordSnapshot('claude', sampleResult());
      recordSnapshot('claude', sampleResult());
      expect(getHistory('claude', 100)).toHaveLength(2);
    });
  });

  describe('bounds enforcement', () => {
    it('caps snapshots at MAX_SNAPSHOTS_PER_PROVIDER', () => {
      const { MAX_SNAPSHOTS_PER_PROVIDER } = _bounds;
      for (let i = 0; i < MAX_SNAPSHOTS_PER_PROVIDER + 10; i++) {
        recordSnapshot('claude', sampleResult({ fetchedAt: i }));
      }
      const history = getHistory('claude');
      expect(history.length).toBeLessThanOrEqual(MAX_SNAPSHOTS_PER_PROVIDER);
      // The oldest 10 should have been pruned.
      expect(history[0].result.fetchedAt).toBe(10);
    });

    it('prunes snapshots older than 30 days', () => {
      const { MAX_AGE_MS } = _bounds;
      recordSnapshot('claude', sampleResult({ fetchedAt: 1 }));
      const historyFile = path.join(tempDir, 'quota', 'history', 'claude.json');
      const oldTime = Date.now() - MAX_AGE_MS - 1000;
      const freshTime = Date.now();
      const entries = [
        { result: sampleResult({ fetchedAt: 0 }), recordedAt: oldTime },
        { result: sampleResult({ fetchedAt: 1 }), recordedAt: freshTime }
      ];
      fs.writeFileSync(historyFile, JSON.stringify(entries, null, 2));
      _resetForTest();
      const history = getHistory('claude');
      expect(history.length).toBe(1);
      expect(history[0].result.fetchedAt).toBe(1);
    });
  });

  describe('getTrend', () => {
    it('returns unknown for missing provider', () => {
      const trend = getTrend('nonexistent');
      expect(trend.direction).toBe('unknown');
      expect(trend.delta).toBeNull();
      expect(trend.slope).toBeNull();
      expect(trend.projected).toBeNull();
      expect(trend.samples).toBe(0);
    });

    it('returns unknown for empty providerId', () => {
      const trend = getTrend('');
      expect(trend.direction).toBe('unknown');
    });

    it('returns unknown with fewer than 2 snapshots', () => {
      recordSnapshot('claude', sampleResult());
      const trend = getTrend('claude');
      expect(trend.direction).toBe('unknown');
      expect(trend.samples).toBe(1);
    });

    it('returns flat when remaining does not change', () => {
      recordSnapshot('claude', sampleResult({ usage: { windows: { '5h': { usedPercent: 60, remainingPercent: 40 } } } }));
      recordSnapshot('claude', sampleResult({ usage: { windows: { '5h': { usedPercent: 60, remainingPercent: 40 } } } }));
      const trend = getTrend('claude');
      expect(trend.direction).toBe('flat');
      expect(trend.delta).toBe(0);
    });

    it('returns down when remaining decreases', () => {
      recordSnapshot('claude', sampleResult({ usage: { windows: { '5h': { usedPercent: 50, remainingPercent: 50 } } } }));
      recordSnapshot('claude', sampleResult({ usage: { windows: { '5h': { usedPercent: 80, remainingPercent: 20 } } } }));
      const trend = getTrend('claude');
      expect(trend.direction).toBe('down');
      expect(trend.delta).toBe(-30);
    });

    it('returns up when remaining increases', () => {
      recordSnapshot('claude', sampleResult({ usage: { windows: { '5h': { usedPercent: 80, remainingPercent: 20 } } } }));
      recordSnapshot('claude', sampleResult({ usage: { windows: { '5h': { usedPercent: 50, remainingPercent: 50 } } } }));
      const trend = getTrend('claude');
      expect(trend.direction).toBe('up');
      expect(trend.delta).toBe(30);
    });

    it('computes a projected value', () => {
      const { MAX_AGE_MS } = _bounds;
      const historyFile = path.join(tempDir, 'quota', 'history', 'claude.json');
      fs.mkdirSync(path.join(tempDir, 'quota', 'history'), { recursive: true });
      const t0 = Date.now() - 10000;
      const t1 = Date.now();
      const entries = [
        { result: sampleResult({ usage: { windows: { '5h': { usedPercent: 50, remainingPercent: 50 } } } }), recordedAt: t0 },
        { result: sampleResult({ usage: { windows: { '5h': { usedPercent: 60, remainingPercent: 40 } } } }), recordedAt: t1 }
      ];
      fs.writeFileSync(historyFile, JSON.stringify(entries, null, 2));
      _resetForTest();
      const trend = getTrend('claude');
      expect(trend.projected).not.toBeNull();
      expect(trend.projected).toBeLessThan(40);
    });

    it('returns unknown when snapshots have no usable metric', () => {
      recordSnapshot('claude', sampleResult({ usage: { windows: { '5h': {} } } }));
      recordSnapshot('claude', sampleResult({ usage: { windows: { '5h': {} } } }));
      const trend = getTrend('claude');
      expect(trend.direction).toBe('unknown');
      expect(trend.samples).toBe(0);
    });
  });

  describe('clearHistory', () => {
    it('removes history for a provider', () => {
      recordSnapshot('claude', sampleResult());
      clearHistory('claude');
      expect(getHistory('claude')).toEqual([]);
      const historyFile = path.join(tempDir, 'quota', 'history', 'claude.json');
      expect(fs.existsSync(historyFile)).toBe(false);
    });

    it('is a no-op for missing provider', () => {
      expect(() => clearHistory('nonexistent')).not.toThrow();
    });
  });

  describe('corrupt disk history', () => {
    it('starts empty when disk file is corrupt', () => {
      const historyDir = path.join(tempDir, 'quota', 'history');
      fs.mkdirSync(historyDir, { recursive: true });
      fs.writeFileSync(path.join(historyDir, 'claude.json'), '{ not valid json');
      _resetForTest();
      expect(getHistory('claude')).toEqual([]);
    });
  });

  describe('providerId sanitization', () => {
    it('sanitizes providerIds with special characters for filenames', () => {
      recordSnapshot('github-copilot-addon', sampleResult({ providerId: 'github-copilot-addon' }));
      const historyFile = path.join(tempDir, 'quota', 'history', 'github-copilot-addon.json');
      expect(fs.existsSync(historyFile)).toBe(true);
    });
  });
});