import { describe, expect, test } from 'bun:test';

import { diffFindI18n } from './diff-find.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('diff find bar translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = diffFindI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = diffFindI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });

  test('the count keeps its current and total placeholders in every locale', () => {
    for (const locale of locales) {
      const value = diffFindI18n[locale]['diffFind.countAria'];
      expect(value).toContain('{current}');
      expect(value).toContain('{total}');
    }
  });
});
