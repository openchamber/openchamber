import { describe, expect, test } from 'bun:test';

import { sessionMenuHintsI18n } from './session-menu-hints.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

describe('session menu hint translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(sessionMenuHintsI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(sessionMenuHintsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
