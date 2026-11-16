import { describe, expect, test } from 'bun:test';

import { clampPercent, compactQuotaValueLabel, formatPercent, formatQuotaResetShort, formatQuotaValueLabel, formatWindowLabel } from './utils';
import { formatMessage } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) => formatMessage(dict, key, params);

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
});

describe('short reset times and compact counts for a narrow row', () => {
  // Thursday 12 November 2026, 10:00 local time.
  const now = new Date(2026, 10, 12, 10, 0);
  const at = (days: number, hour: number, minute = 0) => new Date(2026, 10, 12 + days, hour, minute).getTime();

  test('a reset today shows its time alone, within the week its weekday and time, beyond it the month and day', () => {
    expect(formatQuotaResetShort(at(0, 17), null, '24h', now)).toBe('17:00');
    expect(formatQuotaResetShort(at(1, 12, 9), null, '24h', now)).toBe('Fri 12:09');
    expect(formatQuotaResetShort(at(19, 9), null, '24h', now)).toBe('Dec 1');
    expect(formatQuotaResetShort(null, 'in 3h', '24h', now)).toBe('in 3h');
  });

  test('long numbers in a count compact as token counts do; short ones stay as written', () => {
    expect(compactQuotaValueLabel('10.2 / 20,000 used')).toBe('10.2 / 20K used');
    expect(compactQuotaValueLabel('1,250,000 tokens')).toBe('1.3M tokens');
    expect(compactQuotaValueLabel('3,233 Credits Used')).toBe('3,233 Credits Used');
    expect(compactQuotaValueLabel('42%')).toBe('42%');
  });
});
