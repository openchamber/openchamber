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
});
