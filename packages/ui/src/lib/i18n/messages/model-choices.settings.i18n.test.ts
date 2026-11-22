import { describe, expect, test } from 'bun:test';

import { modelChoicesSettingsI18n } from './model-choices.settings.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('model choice translations', () => {
  test('every locale has every key, translated, with the same placeholders', () => {
    const english = Object.entries(modelChoicesSettingsI18n.en);
    const placeholders = (text: string | undefined) => (text?.match(/\{\w+\}/g) ?? []).sort();
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(modelChoicesSettingsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        expect(placeholders(dictionary.get(key))).toEqual(placeholders(englishText));
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
