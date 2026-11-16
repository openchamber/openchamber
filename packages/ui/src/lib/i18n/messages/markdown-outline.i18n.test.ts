import { describe, expect, test } from 'bun:test';

import { markdownOutlineI18n } from './markdown-outline.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('markdown preview outline translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = markdownOutlineI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBe(4);
    for (const locale of locales) {
      const translated: Record<string, string> = markdownOutlineI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });
});
