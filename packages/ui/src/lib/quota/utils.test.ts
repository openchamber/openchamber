import { describe, expect, test } from 'bun:test';

import { clampPercent, formatPercent, QUOTA_RESULTS_STALE_AFTER_MS, shouldRefreshQuotaResults } from './utils';

describe('quota utils', () => {
  test('treats non-finite percentages as missing', () => {
    expect(clampPercent(Infinity)).toBeNull();
    expect(clampPercent(-Infinity)).toBeNull();

    expect(formatPercent(Infinity)).toBe('-');
    expect(formatPercent(-Infinity)).toBe('-');
  });
});

describe('shouldRefreshQuotaResults', () => {
  const now = 1_000_000;
  const fresh = (providerId: string, ageMs = 0) => ({ providerId, fetchedAt: now - ageMs });

  test('refreshes when any enabled provider has no result at all', () => {
    expect(shouldRefreshQuotaResults(['a', 'b'], [fresh('a')], now, 60_000)).toBe(true);
    expect(shouldRefreshQuotaResults(['a', 'b'], [], now, 60_000)).toBe(true);
  });

  test('refreshes when an existing result is older than the stale window', () => {
    expect(shouldRefreshQuotaResults(['a'], [fresh('a', 61_000)], now, 60_000)).toBe(true);
    expect(shouldRefreshQuotaResults(['a'], [fresh('a', 60_000)], now, 60_000)).toBe(true);
  });

  test('skips the refresh when every enabled provider is fresh enough', () => {
    expect(shouldRefreshQuotaResults(['a', 'b'], [fresh('a', 1_000), fresh('b', 59_000)], now, 60_000)).toBe(false);
    expect(shouldRefreshQuotaResults([], [], now, 60_000)).toBe(false);
  });

  test('the default stale window matches the default auto-refresh cadence', () => {
    expect(QUOTA_RESULTS_STALE_AFTER_MS).toBe(60_000);
  });
});
