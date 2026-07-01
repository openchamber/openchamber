import { describe, expect, it } from 'vitest';

import {
  buildSummary,
  sortProviders,
  getLowQuotaProviders,
  getLowestRemaining,
  getSoonestReset,
  _defaults
} from './summary.js';

const result = (overrides = {}) => ({
  providerId: 'claude',
  providerName: 'Claude',
  ok: true,
  configured: true,
  usage: null,
  fetchedAt: Date.now(),
  ...overrides
});

const withWindows = (windows, overrides = {}) =>
  result({ usage: { windows }, ...overrides });

describe('getLowestRemaining', () => {
  it('returns null for missing usage', () => {
    expect(getLowestRemaining(result())).toBeNull();
    expect(getLowestRemaining(null)).toBeNull();
    expect(getLowestRemaining({ usage: null })).toBeNull();
  });

  it('returns null when windows have no remainingPercent', () => {
    expect(getLowestRemaining(withWindows({ '5h': {} }))).toBeNull();
    expect(getLowestRemaining(withWindows({ '5h': { remainingPercent: null } }))).toBeNull();
    expect(getLowestRemaining(withWindows({ '5h': { remainingPercent: NaN } }))).toBeNull();
    expect(getLowestRemaining(withWindows({ '5h': { remainingPercent: Infinity } }))).toBeNull();
  });

  it('returns the lowest remainingPercent across windows', () => {
    const r = withWindows({
      '5h': { remainingPercent: 40 },
      '7d': { remainingPercent: 20 },
      'weekly': { remainingPercent: 60 }
    });
    expect(getLowestRemaining(r)).toBe(20);
  });

  it('returns the single remainingPercent when only one window', () => {
    expect(getLowestRemaining(withWindows({ '5h': { remainingPercent: 40 } }))).toBe(40);
  });

  it('considers per-account windows for multi-account providers', () => {
    const r = result({
      usage: {
        windows: { '5h': { remainingPercent: 80 } },
        accounts: [
          { accountKey: 'a', windows: { '5h': { remainingPercent: 5 } } },
          { accountKey: 'b', windows: { '5h': { remainingPercent: 50 } } }
        ]
      }
    });
    expect(getLowestRemaining(r)).toBe(5);
  });

  it('returns null when only accounts exist but none have windows', () => {
    const r = result({
      usage: {
        windows: { '5h': { remainingPercent: 80 } },
        accounts: [
          { accountKey: 'a' },
          { accountKey: 'b', windows: { '5h': { remainingPercent: null } } }
        ]
      }
    });
    expect(getLowestRemaining(r)).toBe(80);
  });
});

describe('getSoonestReset', () => {
  it('returns null for missing usage', () => {
    expect(getSoonestReset(result())).toBeNull();
    expect(getSoonestReset(null)).toBeNull();
  });

  it('returns null when windows have no resetAt', () => {
    expect(getSoonestReset(withWindows({ '5h': {} }))).toBeNull();
  });

  it('returns null when all resets are in the past', () => {
    const past = Date.now() - 10000;
    const r = withWindows({ '5h': { resetAt: past } });
    expect(getSoonestReset(r)).toBeNull();
  });

  it('returns the soonest future reset across windows', () => {
    const soon = Date.now() + 10000;
    const later = Date.now() + 50000;
    const r = withWindows({
      '5h': { resetAt: later },
      '7d': { resetAt: soon }
    });
    expect(getSoonestReset(r)).toBe(soon);
  });

  it('accepts epoch seconds (under 1e12) and converts to ms', () => {
    const futureSeconds = Math.floor((Date.now() + 10000) / 1000);
    const r = withWindows({ '5h': { resetAt: futureSeconds } });
    const reset = getSoonestReset(r);
    expect(reset).not.toBeNull();
    expect(reset).toBe(futureSeconds * 1000);
  });

  it('accepts ISO date strings', () => {
    const future = new Date(Date.now() + 10000).toISOString();
    const r = withWindows({ '5h': { resetAt: future } });
    expect(getSoonestReset(r)).not.toBeNull();
  });

  it('ignores invalid resetAt values', () => {
    const valid = Date.now() + 10000;
    const r = withWindows({
      '5h': { resetAt: 'not-a-date' },
      '7d': { resetAt: valid }
    });
    expect(getSoonestReset(r)).toBe(valid);
  });

  it('considers per-account windows for soonest reset', () => {
    const soon = Date.now() + 10000;
    const later = Date.now() + 50000;
    const r = result({
      usage: {
        windows: { '5h': { resetAt: later } },
        accounts: [
          { accountKey: 'a', windows: { '5h': { resetAt: soon } } },
          { accountKey: 'b', windows: { '5h': { resetAt: later } } }
        ]
      }
    });
    expect(getSoonestReset(r)).toBe(soon);
  });
});

describe('buildSummary', () => {
  it('returns zeros for empty input', () => {
    const summary = buildSummary([]);
    expect(summary.totalProviders).toBe(0);
    expect(summary.okProviders).toBe(0);
    expect(summary.configuredProviders).toBe(0);
    expect(summary.lowestRemaining).toBeNull();
    expect(summary.soonestReset).toBeNull();
    expect(summary.lowQuotaCount).toBe(0);
  });

  it('handles non-array input', () => {
    const summary = buildSummary(null);
    expect(summary.totalProviders).toBe(0);
  });

  it('counts ok and configured providers', () => {
    const results = [
      result({ ok: true, configured: true }),
      result({ ok: false, configured: true }),
      result({ ok: true, configured: false })
    ];
    const summary = buildSummary(results);
    expect(summary.totalProviders).toBe(3);
    expect(summary.okProviders).toBe(2);
    expect(summary.configuredProviders).toBe(2);
  });

  it('computes lowestRemaining across all providers', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 40 } }),
      withWindows({ '5h': { remainingPercent: 20 } }),
      withWindows({ '5h': { remainingPercent: 60 } })
    ];
    const summary = buildSummary(results);
    expect(summary.lowestRemaining).toBe(20);
  });

  it('computes soonestReset across all providers', () => {
    const soon = Date.now() + 10000;
    const later = Date.now() + 50000;
    const results = [
      withWindows({ '5h': { resetAt: later } }),
      withWindows({ '5h': { resetAt: soon } })
    ];
    const summary = buildSummary(results);
    expect(summary.soonestReset).toBe(soon);
  });

  it('counts low quota providers below threshold', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 40 } }),
      withWindows({ '5h': { remainingPercent: 15 } }),
      withWindows({ '5h': { remainingPercent: 5 } }),
      withWindows({ '5h': {} })
    ];
    const summary = buildSummary(results, { lowQuotaThreshold: 20 });
    expect(summary.lowQuotaCount).toBe(2);
    expect(summary.lowQuotaThreshold).toBe(20);
  });

  it('uses default threshold when not specified', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 15 } })
    ];
    const summary = buildSummary(results);
    expect(summary.lowQuotaThreshold).toBe(_defaults.DEFAULT_LOW_QUOTA_THRESHOLD);
    expect(summary.lowQuotaCount).toBe(1);
  });

  it('skips null/invalid entries', () => {
    const summary = buildSummary([null, undefined, { foo: 'bar' }]);
    expect(summary.totalProviders).toBe(3);
    expect(summary.okProviders).toBe(0);
  });
});

describe('sortProviders', () => {
  it('returns empty array for non-array input', () => {
    expect(sortProviders(null)).toEqual([]);
    expect(sortProviders(undefined)).toEqual([]);
  });

  it('sorts by urgency (lowest remaining first)', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 60 } }, { providerId: 'a', providerName: 'A' }),
      withWindows({ '5h': { remainingPercent: 10 } }, { providerId: 'b', providerName: 'B' }),
      withWindows({ '5h': { remainingPercent: 40 } }, { providerId: 'c', providerName: 'C' })
    ];
    const sorted = sortProviders(results, 'urgency');
    expect(sorted.map((r) => r.providerId)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by name alphabetically', () => {
    const results = [
      result({ providerId: 'c', providerName: 'Charlie' }),
      result({ providerId: 'a', providerName: 'Alpha' }),
      result({ providerId: 'b', providerName: 'Bravo' })
    ];
    const sorted = sortProviders(results, 'name');
    expect(sorted.map((r) => r.providerId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by name case-insensitively', () => {
    const results = [
      result({ providerId: 'b', providerName: 'bravo' }),
      result({ providerId: 'a', providerName: 'Alpha' })
    ];
    const sorted = sortProviders(results, 'name');
    expect(sorted.map((r) => r.providerId)).toEqual(['a', 'b']);
  });

  it('sorts by reset time (soonest first)', () => {
    const soon = Date.now() + 10000;
    const later = Date.now() + 50000;
    const results = [
      withWindows({ '5h': { resetAt: later } }, { providerId: 'b' }),
      withWindows({ '5h': { resetAt: soon } }, { providerId: 'a' })
    ];
    const sorted = sortProviders(results, 'reset');
    expect(sorted.map((r) => r.providerId)).toEqual(['a', 'b']);
  });

  it('defaults to urgency for unknown sortBy', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 60 } }, { providerId: 'a' }),
      withWindows({ '5h': { remainingPercent: 10 } }, { providerId: 'b' })
    ];
    const sorted = sortProviders(results, 'unknown-key');
    expect(sorted.map((r) => r.providerId)).toEqual(['b', 'a']);
  });

  it('places providers with no remaining data last for urgency', () => {
    const results = [
      withWindows({ '5h': {} }, { providerId: 'no-data' }),
      withWindows({ '5h': { remainingPercent: 30 } }, { providerId: 'has-data' })
    ];
    const sorted = sortProviders(results, 'urgency');
    expect(sorted[0].providerId).toBe('has-data');
    expect(sorted[1].providerId).toBe('no-data');
  });

  it('places providers with no reset data last for reset sort', () => {
    const soon = Date.now() + 10000;
    const results = [
      withWindows({ '5h': {} }, { providerId: 'no-reset' }),
      withWindows({ '5h': { resetAt: soon } }, { providerId: 'has-reset' })
    ];
    const sorted = sortProviders(results, 'reset');
    expect(sorted[0].providerId).toBe('has-reset');
    expect(sorted[1].providerId).toBe('no-reset');
  });

  it('does not mutate the input array', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 60 } }, { providerId: 'a' }),
      withWindows({ '5h': { remainingPercent: 10 } }, { providerId: 'b' })
    ];
    const original = [...results];
    sortProviders(results, 'urgency');
    expect(results.map((r) => r.providerId)).toEqual(original.map((r) => r.providerId));
  });
});

describe('getLowQuotaProviders', () => {
  it('returns providers below the threshold', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 40 } }, { providerId: 'a' }),
      withWindows({ '5h': { remainingPercent: 15 } }, { providerId: 'b' }),
      withWindows({ '5h': { remainingPercent: 5 } }, { providerId: 'c' })
    ];
    const low = getLowQuotaProviders(results, 20);
    expect(low.map((r) => r.providerId)).toEqual(['c', 'b']);
  });

  it('excludes providers with no usable remaining data', () => {
    const results = [
      withWindows({ '5h': {} }, { providerId: 'no-data' }),
      withWindows({ '5h': { remainingPercent: 10 } }, { providerId: 'low' })
    ];
    const low = getLowQuotaProviders(results, 20);
    expect(low.map((r) => r.providerId)).toEqual(['low']);
  });

  it('returns empty array when no providers are below threshold', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 50 } }, { providerId: 'a' }),
      withWindows({ '5h': { remainingPercent: 80 } }, { providerId: 'b' })
    ];
    expect(getLowQuotaProviders(results, 20)).toEqual([]);
  });

  it('uses default threshold when not specified', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 15 } }, { providerId: 'a' })
    ];
    const low = getLowQuotaProviders(results);
    expect(low).toHaveLength(1);
  });

  it('handles non-array input', () => {
    expect(getLowQuotaProviders(null, 20)).toEqual([]);
  });

  it('returns results sorted by urgency', () => {
    const results = [
      withWindows({ '5h': { remainingPercent: 15 } }, { providerId: 'a' }),
      withWindows({ '5h': { remainingPercent: 5 } }, { providerId: 'b' }),
      withWindows({ '5h': { remainingPercent: 10 } }, { providerId: 'c' })
    ];
    const low = getLowQuotaProviders(results, 20);
    expect(low.map((r) => r.providerId)).toEqual(['b', 'c', 'a']);
  });
});