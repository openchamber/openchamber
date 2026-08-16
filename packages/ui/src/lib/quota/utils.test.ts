import { describe, expect, test } from 'bun:test';

import { clampPercent, formatPercent, calculatePace, getPaceStatusColor, formatRemainingTime, calculateExpectedUsagePercent } from './utils';

describe('quota utils', () => {
  test('treats non-finite percentages as missing', () => {
    expect(clampPercent(Infinity)).toBeNull();
    expect(clampPercent(-Infinity)).toBeNull();

    expect(formatPercent(Infinity)).toBe('-');
    expect(formatPercent(-Infinity)).toBe('-');
  });
});

describe('calculatePace', () => {
  const futureReset = () => Date.now() + 12 * 3600 * 1000;

  test('returns null when inputs cannot describe a window', () => {
    expect(calculatePace(null, futureReset(), 3600, '1h')).toBeNull();
    expect(calculatePace(50, null, 3600, '1h')).toBeNull();
    expect(calculatePace(50, futureReset(), null, 'unknown-label')).toBeNull();
    expect(calculatePace(50, futureReset(), 0, '1h')).toBeNull();
  });

  test('infers window duration from the label when windowSeconds is missing', () => {
    const pace = calculatePace(50, futureReset(), null, '7d');
    expect(pace).not.toBeNull();
    expect(pace?.totalSeconds).toBe(7 * 86400);
  });

  test('accepts resetAt as an ISO string like the opencode-go provider sends', () => {
    const resetAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    const pace = calculatePace(50, resetAt, 24 * 3600, '24h');
    expect(pace).not.toBeNull();
    expect(pace?.paceRateText).not.toBe('-');
    expect(pace?.status).toBe('on-track');
  });

  test('classifies on-track when usage is at or below the elapsed ratio', () => {
    const resetAt = Date.now() + 12 * 3600 * 1000;
    const pace = calculatePace(50, resetAt, 24 * 3600, '24h');
    expect(pace?.status).toBe('on-track');
  });

  test('classifies slightly-fast when the projection stays under 130%', () => {
    const resetAt = Date.now() + 18 * 3600 * 1000;
    const pace = calculatePace(50, resetAt, 24 * 3600, '24h');
    expect(pace?.status).toBe('too-fast');
  });

  test('formats pace rate per hour for short windows and per day for long ones', () => {
    const short = calculatePace(25, Date.now() + 3 * 3600 * 1000, 5 * 3600, '5h');
    expect(short?.paceRateText).toContain('%/h');

    const long = calculatePace(25, Date.now() + 6 * 86400 * 1000, 7 * 86400, '7d');
    expect(long?.paceRateText).toContain('%/d');
  });

  test('marks exhausted windows and reports the remaining wait', () => {
    const pace = calculatePace(100, Date.now() + 3600 * 1000, 24 * 3600, '24h');
    expect(pace?.isExhausted).toBe(true);
    expect(pace?.status).toBe('exhausted');
    expect(Math.round((pace?.remainingSeconds ?? 0) / 3600)).toBe(1);
  });

  test('clamps absurd projections at 999%', () => {
    const resetAt = Date.now() + 23.7 * 3600 * 1000;
    const pace = calculatePace(50, resetAt, 24 * 3600, '24h');
    expect(pace?.predictedFinalPercent).toBe(999);
  });

  test('sets a daily allocation for weekly and monthly windows', () => {
    const weekly = calculatePace(10, Date.now() + 6 * 86400 * 1000, 7 * 86400, '7d');
    expect(Math.abs((weekly?.dailyAllocationPercent ?? 0) - 100 / 7)).toBeLessThan(0.001);

    const hourly = calculatePace(10, Date.now() + 3 * 3600 * 1000, 5 * 3600, '5h');
    expect(hourly?.dailyAllocationPercent).toBeNull();
  });
});

describe('pace helpers', () => {
  test('maps every pace status to a status token', () => {
    expect(getPaceStatusColor('on-track')).toBe('var(--status-success)');
    expect(getPaceStatusColor('slightly-fast')).toBe('var(--status-warning)');
    expect(getPaceStatusColor('too-fast')).toBe('var(--status-error)');
    expect(getPaceStatusColor('exhausted')).toBe('var(--status-error)');
  });

  test('formats remaining time compactly', () => {
    expect(formatRemainingTime(0)).toBe('<1m');
    expect(formatRemainingTime(59)).toBe('<1m');
    expect(formatRemainingTime(3600)).toBe('1h');
    expect(formatRemainingTime(90000)).toBe('1d 1h');
  });

  test('computes the expected usage marker from the elapsed ratio', () => {
    expect(calculateExpectedUsagePercent(0.5)).toBe(50);
    expect(calculateExpectedUsagePercent(1.5)).toBe(100);
    expect(calculateExpectedUsagePercent(-0.5)).toBe(0);
  });
});
