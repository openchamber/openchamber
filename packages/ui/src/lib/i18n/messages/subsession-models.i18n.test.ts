import { describe, expect, test } from 'bun:test';

import { subsessionModelsI18n } from './subsession-models.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('subsession models translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(subsessionModelsI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(subsessionModelsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        const text = dictionary.get(key) ?? '';
        expect(`${locale} ${key}: ${text.trim()}`).not.toBe(`${locale} ${key}: `);
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${text}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
