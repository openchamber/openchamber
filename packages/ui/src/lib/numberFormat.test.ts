import { afterEach, describe, expect, test } from 'bun:test';
import { useI18nStore } from './i18n/store';
import { formatCompactNumber } from './numberFormat';

const defaultLocale = useI18nStore.getState().locale;

afterEach(() => {
  useI18nStore.setState({ locale: defaultLocale });
});

describe('formatCompactNumber', () => {
  test('keeps values below one thousand verbatim', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });

  test('uses short compact notation with at most one fraction digit', () => {
    expect(formatCompactNumber(1000)).toBe('1K');
    expect(formatCompactNumber(1500)).toBe('1.5K');
    expect(formatCompactNumber(12_345)).toBe('12.3K');
    expect(formatCompactNumber(2_500_000)).toBe('2.5M');
  });

  test('follows the active intl locale', () => {
    useI18nStore.setState({ locale: 'de' });
    expect(formatCompactNumber(1500)).toBe('1500');
  });
});
