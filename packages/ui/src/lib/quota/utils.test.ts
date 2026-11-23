import { describe, expect, test } from 'bun:test';

import { clampPercent, compactQuotaValueLabel, formatPercent, formatQuotaResetDuration, formatQuotaResetRelative, formatQuotaResetShort, formatQuotaRowValue, formatQuotaValueLabel, formatQuotaWindowValueLabel, formatWindowLabel } from './utils';
import type { UsageWindow } from '@/types';
import { formatMessage } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) => formatMessage(dict, key, params);

const quotaWindow = (window: Partial<UsageWindow>): UsageWindow => ({
  usedPercent: null,
  remainingPercent: null,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  ...window,
});

describe('quota utils', () => {
  test('formats semantic consumption with grouping and at most one decimal', () => {
    expect(formatQuotaValueLabel({ creditsUsed: 3233 }, null, t)).toBe('3,233 Credits Used');
    expect(formatQuotaValueLabel({ creditsUsed: 3233.27 }, null, t)).toBe('3,233.3 Credits Used');
    expect(formatQuotaValueLabel({ creditsUsed: 0 }, null, t)).toBe('0 Credits Used');
    expect(formatQuotaValueLabel({ valueLabel: 'Unlimited' }, null, t)).toBe('Unlimited');
    expect(formatQuotaValueLabel({}, 42, t)).toBe('42%');
  });
  test('treats non-finite percentages as missing', () => {
    expect(clampPercent(Infinity)).toBeNull();
    expect(clampPercent(-Infinity)).toBeNull();

    expect(formatPercent(Infinity)).toBe('-');
    expect(formatPercent(-Infinity)).toBe('-');
  });

  test('labels Copilot usage as AI Credits without changing generic premium usage', () => {
    expect(formatWindowLabel('premium')).toBe('Premium Interactions');
    expect(formatWindowLabel('premium_interactions')).toBe('AI Credits');
  });

  test('labels the OpenRouter key cap apart from credit balances', () => {
    expect(formatWindowLabel('key_limit')).toBe('Key Limit');
    expect(formatWindowLabel('credits')).toBe('Credits');
  });

  test('labels dollar usage separately from credits', () => {
    expect(formatWindowLabel('usage')).toBe('Usage');
    expect(formatWindowLabel('credits')).toBe('Credits');
  });

  test('labels monthly spending rows apart from the monthly cap', () => {
    expect(formatWindowLabel('monthly')).toBe('Monthly');
    expect(formatWindowLabel('monthly_total')).toBe('Monthly Total');
    expect(formatWindowLabel('monthly_credits')).toBe('Monthly Credits');
    expect(formatWindowLabel('monthly_byok')).toBe('Monthly BYOK');
  });

  test('formats the monthly total from the raw summed amount and keeps an unreadable amount unknown', () => {
    expect(formatQuotaWindowValueLabel(
      quotaWindow({ value: { kind: 'spend', spent: 14.297788398 + 212.345956722, limit: null } }), null, t,
    )).toBe('$226.64 spent');
    expect(formatQuotaWindowValueLabel(
      quotaWindow({ value: { kind: 'spend', spent: 14.297788398, limit: null } }), null, t,
    )).toBe('$14.30 spent');
    expect(formatQuotaWindowValueLabel(
      quotaWindow({ value: { kind: 'spend', spent: null, limit: null } }), null, t,
    )).toBe('Unknown');
  });

  test('a usage row keeps the cap percent and otherwise uses money or the cap label', () => {
    expect(formatQuotaRowValue(quotaWindow({ usedPercent: 40, valueLabel: '$5.00 / $30.00' }), 40, t)).toBe('40%');
    expect(formatQuotaRowValue(
      quotaWindow({ value: { kind: 'spend', spent: 226.64374512, limit: null } }), null, t,
    )).toBe('$226.64 spent');
    expect(formatQuotaRowValue(
      quotaWindow({ value: { kind: 'spend', spent: null, limit: null } }), null, t,
    )).toBe('Unknown');
    expect(formatQuotaRowValue(quotaWindow({ valueLabel: '$0.00 / $0.00' }), null, t)).toBe('$0.00 / $0.00');
  });

  test('a set cap with an unreadable amount keeps its limit visible', () => {
    const cap = quotaWindow({ value: { kind: 'spend', spent: null, limit: 30 } });
    expect(formatQuotaWindowValueLabel(cap, null, t)).toBe('Unknown of $30.00');
    expect(formatQuotaRowValue(cap, null, t)).toBe('Unknown of $30.00');
  });
});

describe('short reset times and compact counts for a narrow row', () => {
  // Thursday 12 November 2026, 10:00 local time.
  const now = new Date(2026, 10, 12, 10, 0);
  const at = (days: number, hour: number, minute = 0) => new Date(2026, 10, 12 + days, hour, minute).getTime();

  test('a reset today shows its time alone, within the week its weekday and time, beyond it the month and day', () => {
    expect(formatQuotaResetShort(at(0, 17), null, '24h', { now })).toBe('17:00');
    expect(formatQuotaResetShort(at(1, 12, 9), null, '24h', { now })).toBe('Fri 12:09');
    expect(formatQuotaResetShort(at(19, 9), null, '24h', { now })).toBe('Dec 1');
    expect(formatQuotaResetShort(null, 'in 3h', '24h', { now })).toBe('in 3h');
  });

  test('the Claude 7-day reset keeps its clock time across a minute boundary', () => {
    const cutoff = at(7, 10);
    const claude = { providerId: 'claude', now };
    expect(formatQuotaResetShort(cutoff - 1000, null, '24h', claude)).toBe('Thu 10:00');
    expect(formatQuotaResetShort(cutoff, null, '24h', claude)).toBe('Thu 10:00');
    expect(formatQuotaResetShort(cutoff + 1000, null, '24h', claude)).toBe('Thu 10:00');
    expect(formatQuotaResetShort(cutoff + 60_000, null, '24h', claude)).toBe('Nov 19');
    expect(formatQuotaResetShort(cutoff, null, '24h', { providerId: 'codex', now })).toBe('Nov 19');
    expect(formatQuotaResetShort(cutoff, null, '24h', { ...claude, now: new Date(now.getTime() - 1000) })).toBe('Thu 10:00');
  });

  test('an elapsed Claude reset is not rounded into an upcoming one', () => {
    const lateNow = new Date(2026, 10, 12, 23, 59, 55);
    const elapsed = new Date(2026, 10, 12, 23, 59, 45).getTime();
    expect(formatQuotaResetShort(elapsed, null, '24h', { providerId: 'claude', now: lateNow })).toBe('23:59');
  });

  test('the time left before a reset reads in minutes, hours and minutes, or whole days', () => {
    const at = (hour: number, minute = 0) => new Date(2026, 10, 12, hour, minute).getTime();
    const later = (days: number, hour: number) => new Date(2026, 10, 12 + days, hour).getTime();
    expect(formatQuotaResetRelative(at(10, 45), { now })).toBe('in 45m');
    expect(formatQuotaResetRelative(at(12, 35), { now })).toBe('in 2h 35m');
    expect(formatQuotaResetRelative(at(17), { now })).toBe('in 7h');
    expect(formatQuotaResetRelative(later(1, 12), { now })).toBe('in 1d');
    expect(formatQuotaResetRelative(later(12, 10), { now })).toBe('in 12d');
    expect(formatQuotaResetRelative(new Date(now.getTime() + 30_000).getTime(), { now })).toBe('in less than a minute');
  });

  test('a passed or missing reset has no countdown, so the absolute label stays', () => {
    expect(formatQuotaResetRelative(at(0, 9), { now })).toBeNull();
    expect(formatQuotaResetRelative(null, { now })).toBeNull();
    expect(formatQuotaResetDuration(Number.NaN, { now })).toBeNull();
  });

  test('long numbers in a count compact as token counts do; short ones stay as written', () => {
    expect(compactQuotaValueLabel('10.2 / 20,000 used')).toBe('10.2 / 20K used');
    expect(compactQuotaValueLabel('1,250,000 tokens')).toBe('1.3M tokens');
    expect(compactQuotaValueLabel('3,233 Credits Used')).toBe('3,233 Credits Used');
    expect(compactQuotaValueLabel('42%')).toBe('42%');
  });
});
