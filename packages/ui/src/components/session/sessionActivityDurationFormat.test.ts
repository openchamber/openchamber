import { describe, expect, test } from 'bun:test';

import { dict as enDict } from '@/lib/i18n/messages/en';
import { formatMessage, type I18nKey, type I18nParams } from '@/lib/i18n';
import { formatSessionActivityDuration } from './sessionActivityDurationFormat';

const t = (key: I18nKey, params?: I18nParams): string => formatMessage(enDict, key, params);

const format = (ms: number): string => formatSessionActivityDuration(ms, t);

describe('formatSessionActivityDuration', () => {
  test('renders seconds below a minute', () => {
    expect(format(0)).toBe('0s');
    expect(format(999)).toBe('0s');
    expect(format(7_400)).toBe('7s');
    expect(format(59_999)).toBe('59s');
  });

  test('renders minutes and seconds below an hour', () => {
    expect(format(60_000)).toBe('1m 0s');
    expect(format(83_000)).toBe('1m 23s');
    expect(format(59 * 60_000 + 59_000)).toBe('59m 59s');
  });

  test('drops seconds past an hour so the label stays narrow', () => {
    expect(format(3_600_000)).toBe('1h 0m');
    expect(format(3_600_000 + 2 * 60_000 + 33_000)).toBe('1h 2m');
    expect(format(25 * 3_600_000)).toBe('25h 0m');
  });

  test('clamps a negative duration rather than rendering a negative count', () => {
    expect(format(-5_000)).toBe('0s');
  });
});
