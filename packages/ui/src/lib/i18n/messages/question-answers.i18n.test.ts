import { describe, expect, test } from 'bun:test';

import { questionAnswersI18n } from './question-answers.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('question answers translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(questionAnswersI18n.en);
    expect(english.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(questionAnswersI18n[locale]));
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
