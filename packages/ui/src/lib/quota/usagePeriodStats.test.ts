import { describe, expect, test } from 'bun:test';
import {
  averageCostPer1kTokens,
  buildPeriodUsageSummary,
  percentChange,
  sessionTokenTotal,
} from './usagePeriodStats';
import { resolveQuotaProviderId } from './providerAliases';

describe('resolveQuotaProviderId', () => {
  test('maps OpenCode aliases onto quota providers', () => {
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
    expect(resolveQuotaProviderId('openai')).toBe('codex');
    expect(resolveQuotaProviderId('openrouter')).toBe('openrouter');
  });

  test('returns null for unknown providers', () => {
    expect(resolveQuotaProviderId('unknown-vendor')).toBeNull();
    expect(resolveQuotaProviderId('')).toBeNull();
  });
});

describe('sessionTokenTotal', () => {
  test('sums all token buckets', () => {
    expect(sessionTokenTotal({
      input: 10,
      output: 20,
      reasoning: 5,
      cache: { read: 3, write: 2 },
    })).toBe(40);
  });
});

describe('buildPeriodUsageSummary', () => {
  const day = (offset: number, hour = 12) => {
    const base = new Date('2026-08-17T12:00:00');
    base.setDate(base.getDate() + offset);
    base.setHours(hour, 0, 0, 0);
    return base.getTime();
  };

  test('aggregates current and previous windows by provider and day', () => {
    const summary = buildPeriodUsageSummary(
      [
        {
          cost: 2,
          tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { providerID: 'anthropic' },
          time: { updated: day(0) },
        },
        {
          cost: 1,
          tokens: { input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { providerID: 'openrouter' },
          time: { updated: day(-1) },
        },
        {
          cost: 4,
          tokens: { input: 2000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { providerID: 'anthropic' },
          time: { updated: day(-7) },
        },
      ],
      { periodDays: 7, nowMs: day(0) },
    );

    expect(summary.days).toHaveLength(7);
    expect(summary.totals.cost).toBe(3);
    expect(summary.totals.tokens).toBe(1500);
    expect(summary.totals.requests).toBe(2);
    expect(summary.previousTotals.cost).toBe(4);
    expect(summary.byProvider[0]?.providerId).toBe('claude');
    expect(summary.byProvider[0]?.cost).toBe(2);
  });

  test('respects provider filters', () => {
    const summary = buildPeriodUsageSummary(
      [
        {
          cost: 2,
          tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { providerID: 'anthropic' },
          time: { updated: day(0) },
        },
        {
          cost: 9,
          tokens: { input: 900, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { providerID: 'openrouter' },
          time: { updated: day(0) },
        },
      ],
      { periodDays: 7, nowMs: day(0), providerFilter: 'claude' },
    );

    expect(summary.totals.cost).toBe(2);
    expect(summary.byProvider).toHaveLength(1);
  });
});

describe('percentChange / averageCostPer1kTokens', () => {
  test('computes percent deltas and average cost', () => {
    expect(percentChange(12, 10)).toBe(20);
    expect(percentChange(5, 0)).toBeNull();
    expect(averageCostPer1kTokens(4.4, 1_000_000)).toBe(0.0044);
  });
});
