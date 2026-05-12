import { describe, expect, it } from 'vitest';

import { calculateResetAfterSeconds, formatResetTime } from './formatters.js';

describe('formatResetTime', () => {
  it('returns null for invalid timestamps', () => {
    expect(formatResetTime('not-a-date')).toBeNull();
    expect(formatResetTime(NaN)).toBeNull();
    expect(formatResetTime(Infinity)).toBeNull();
    expect(formatResetTime(-Infinity)).toBeNull();
  });
});

describe('calculateResetAfterSeconds', () => {
  it('returns null for invalid timestamps', () => {
    expect(calculateResetAfterSeconds('not-a-date')).toBeNull();
    expect(calculateResetAfterSeconds(NaN)).toBeNull();
    expect(calculateResetAfterSeconds(Infinity)).toBeNull();
    expect(calculateResetAfterSeconds(-Infinity)).toBeNull();
  });
});
