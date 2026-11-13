import { describe, expect, test } from 'bun:test';

import { snippetsI18n } from './snippets.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

// Words a language spells the same as English.
const sameAsEnglish = new Set(['de snippets.field.name']);

describe('snippet translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(snippetsI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(snippetsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en' && !sameAsEnglish.has(`${locale} ${key}`)) {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
