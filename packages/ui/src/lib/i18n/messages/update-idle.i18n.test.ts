import { describe, expect, test } from 'bun:test';

import { updateIdleI18n } from './update-idle.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('idle update translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = updateIdleI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = updateIdleI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        expect(translated[key]).toBeTruthy();
        if (locale !== 'en') expect(translated[key]).not.toBe(english[key]);
      }
    }
  });

  test('keeps the seconds placeholder in every locale', () => {
    for (const locale of locales) {
      const messages: Record<string, string> = updateIdleI18n[locale];
      expect(messages['updateDialog.idle.counting']).toContain('{seconds}');
      expect(messages['updateDialog.idle.countingOne']).toContain('{seconds}');
    }
  });
});
