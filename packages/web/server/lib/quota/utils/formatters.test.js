import { describe, expect, it } from 'vitest';

import { calculateResetAfterSeconds, formatResetTime, toUsageWindow } from './formatters.js';

describe('formatResetTime', () => {
  it('returns null for invalid timestamps', () => {
    expect(formatResetTime('not-a-date')).toBeNull();
    expect(formatResetTime(NaN)).toBeNull();
    expect(formatResetTime(Infinity)).toBeNull();
    expect(formatResetTime(-Infinity)).toBeNull();
  });
});

describe('calculateResetAfterSeconds', () => {
  it('accepts an epoch reset timestamp', () => {
    expect(calculateResetAfterSeconds(0)).toBe(0);
  });

  it('returns null for invalid timestamps', () => {
    expect(calculateResetAfterSeconds('not-a-date')).toBeNull();
    expect(calculateResetAfterSeconds(NaN)).toBeNull();
    expect(calculateResetAfterSeconds(Infinity)).toBeNull();
    expect(calculateResetAfterSeconds(-Infinity)).toBeNull();
  });
});

describe('toUsageWindow', () => {
  it('formats epoch reset timestamps', () => {
    const usageWindow = toUsageWindow({ resetAt: 0 });

    expect(usageWindow.resetAfterSeconds).toBe(0);
    expect(usageWindow.resetAtFormatted).toBe(formatResetTime(0));
    expect(usageWindow.resetAfterFormatted).toBe(formatResetTime(0));
  });

  it('does not derive remaining percent from missing usage', () => {
    expect(toUsageWindow({ usedPercent: undefined }).remainingPercent).toBeNull();
  });

  it('does not derive remaining percent from non-finite usage', () => {
    expect(toUsageWindow({ usedPercent: NaN }).remainingPercent).toBeNull();
    expect(toUsageWindow({ usedPercent: Infinity }).remainingPercent).toBeNull();
    expect(toUsageWindow({ usedPercent: -Infinity }).remainingPercent).toBeNull();
    expect(toUsageWindow({ usedPercent: null }).remainingPercent).toBeNull();
  });

  it('derives remaining percent from a valid usage value', () => {
    expect(toUsageWindow({ usedPercent: 60 }).remainingPercent).toBe(40);
  });

  it('clamps remaining percent to zero when usage exceeds 100', () => {
    expect(toUsageWindow({ usedPercent: 110 }).remainingPercent).toBe(0);
  });
});
