import { describe, expect, it } from 'vitest';

import { buildResult, calculateResetAfterSeconds, durationToLabel, durationToSeconds, formatCredits, formatMoney, formatResetTime, toUsageWindow } from './formatters.js';

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

  it('preserves missing fields and omits only absent optional labels and credits', () => {
    const window = toUsageWindow({});
    expect(window).toHaveProperty('usedPercent', undefined);
    expect(window).toHaveProperty('resetAt', undefined);
    expect(window.windowSeconds).toBeNull();
    expect(window).not.toHaveProperty('valueLabel');
    expect(window).not.toHaveProperty('creditsUsed');
    expect(toUsageWindow({ valueLabel: '', creditsUsed: undefined })).not.toHaveProperty('valueLabel');
    expect(toUsageWindow({ valueLabel: 'Credits', creditsUsed: 0 })).toMatchObject({ valueLabel: 'Credits', creditsUsed: 0 });
    expect(toUsageWindow({ usedPercent: '60' }).remainingPercent).toBeNull();
  });
});

describe('quota result and labels', () => {
  it('preserves result usage and truthy optional metadata', () => {
    const input = { providerId: 'provider', providerName: 'Provider', ok: false, configured: false };
    const empty = buildResult(input);
    expect(empty).toMatchObject({ ...input, usage: null, fetchedAt: expect.any(Number) });
    for (const field of ['error', 'planLabel', 'accountLabel']) {
      expect(empty).not.toHaveProperty(field);
      expect(buildResult({ ...input, [field]: '' })).not.toHaveProperty(field);
      expect(buildResult({ ...input, [field]: 'label' })).toHaveProperty(field, 'label');
    }
    const usage = { windows: {} };
    expect(buildResult({ ...input, usage }).usage).toBe(usage);
  });

  it('keeps duration fallback and conversion rules', () => {
    for (const [unit, label, seconds] of [
      ['TIME_UNIT_MINUTE', '2m', 120],
      ['TIME_UNIT_HOUR', '2h', 7200],
      ['TIME_UNIT_DAY', '2d', 172800],
      ['unknown', 'limit', null],
    ]) {
      expect(durationToLabel(2, unit)).toBe(label);
      expect(durationToSeconds(2, unit)).toBe(seconds);
    }
    expect(durationToLabel(0, 'TIME_UNIT_HOUR')).toBe('limit');
    expect(durationToSeconds(0, 'TIME_UNIT_HOUR')).toBeNull();
  });

  it('rejects nonnumeric money and credits without coercion', () => {
    for (const value of [null, undefined, '1', {}, [], NaN, Infinity]) {
      expect(formatMoney(value)).toBeNull();
      expect(formatCredits(value)).toBeNull();
    }
    expect(formatMoney(1)).toBe('1.00');
    expect(formatMoney(-1.5)).toBe('-1.50');
    expect(formatCredits(1234.56)).toBe('1,234.6');
    expect(formatCredits(1234)).toBe('1,234');
  });
});
