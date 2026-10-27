import { describe, expect, test } from 'bun:test';

import { autocompleteScopeI18n } from './autocomplete-scope.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
// Product names stay as written in every locale, and so does a word some languages share with English.
const sameAsEnglish = (locale: string, key: string) => key.endsWith('.opencode') || key.endsWith('.openchamber') || (locale === 'nl' && key.endsWith('.project'));

describe('autocomplete scope translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = autocompleteScopeI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = autocompleteScopeI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        expect(translated[key]).toBeTruthy();
        if (locale !== 'en' && !sameAsEnglish(locale, key)) expect(translated[key]).not.toBe(english[key]);
      }
    }
  });
});
