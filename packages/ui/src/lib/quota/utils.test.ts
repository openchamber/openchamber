import { describe, expect, test } from 'bun:test';

import { clampPercent, formatPercent, formatQuotaValueLabel, formatWindowLabel } from './utils';
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
});
