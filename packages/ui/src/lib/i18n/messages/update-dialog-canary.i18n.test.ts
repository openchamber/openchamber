import { describe, expect, test } from 'bun:test';

import { updateDialogCanaryI18n } from './update-dialog-canary.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
// The product name and the date are the whole text of these two.
const SAME_IN_EVERY_LOCALE = new Set(['updateDialog.canary.version', 'updateDialog.canary.night', 'updateDialog.canary.pair', 'updateDialog.canary.build']);

describe('update dialog Canary translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = updateDialogCanaryI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = updateDialogCanaryI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        expect(translated[key]).toBeTruthy();
        if (locale !== 'en' && !SAME_IN_EVERY_LOCALE.has(key)) expect(translated[key]).not.toBe(english[key]);
      }
    }
  });

  test('keeps the placeholders in every locale', () => {
    for (const locale of locales) {
      const messages: Record<string, string> = updateDialogCanaryI18n[locale];
      expect(messages['updateDialog.canary.version']).toContain('{version}');
      expect(messages['updateDialog.canary.night']).toContain('{date}');
      expect(messages['updateDialog.changelog.changeCountPlural']).toContain('{count}');
      expect(messages['updateDialog.changelog.showMore']).toContain('{count}');
    }
  });
});
