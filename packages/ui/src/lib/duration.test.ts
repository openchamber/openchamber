import { describe, expect, test } from 'bun:test';

import { dict as enDict } from '@/lib/i18n/messages/en';
import { formatMessage, type I18nKey, type I18nParams } from '@/lib/i18n';
import { formatCompactDuration } from './duration';

const t = (key: I18nKey, params?: I18nParams): string => formatMessage(enDict, key, params);

const format = (ms: number): string => formatCompactDuration(ms, t);

describe('formatCompactDuration', () => {
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

  test('keeps one decimal below a minute for tool timers', () => {
    const live = (ms: number) => formatCompactDuration(ms, t, { secondsPrecision: 1 });
    expect(live(-100)).toBe('0.0s');
    expect(live(0)).toBe('0.0s');
    expect(live(49)).toBe('0.0s');
    expect(live(50)).toBe('0.1s');
    expect(live(999)).toBe('1.0s');
    expect(live(7_400)).toBe('7.4s');
    expect(live(59_999)).toBe('60.0s');
    expect(live(60_000)).toBe('1m 0s');
    expect(live(83_000)).toBe('1m 23s');
    expect(live(3_600_000)).toBe('1h 0m');
    expect(live(25 * 3_600_000 + 153_000)).toBe('25h 2m');
  });

  test('preserves the completed tool minimum', () => {
    for (const ms of [-100, 0, 1, 49, 50, 99, 100]) {
      expect(formatCompactDuration(ms, t, { secondsPrecision: 1, minimumSeconds: 0.1 })).toBe('0.1s');
    }
    expect(formatCompactDuration(60_000, t, { secondsPrecision: 1, minimumSeconds: 0.1 })).toBe('1m 0s');
  });
});
