import { describe, expect, test } from 'bun:test';
import { toContextUsageReading } from './contextUsageReading';

describe('toContextUsageReading', () => {
  test('shows the unrounded percentage and colours by the rounded one', () => {
    const reading = toContextUsageReading({
      state: 'measured',
      totalTokens: 11_837,
      percentage: 6,
      contextLimit: 200_000,
      thresholdLimit: 200_000,
    });
    expect(reading).toEqual({ state: 'measured', totalTokens: 11_837, percentage: 5.9185, colorPercentage: 6 });
  });

  test('carries no number for a compacted session', () => {
    const reading = toContextUsageReading({ state: 'compacted', contextLimit: 200_000, thresholdLimit: 200_000 });
    expect(reading).toEqual({ state: 'compacted' });
  });
});
