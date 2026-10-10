import { describe, expect, test } from 'bun:test';
import { openCodeProjectImportI18n } from './open-code-project-import.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

describe('OpenCode project import translations', () => {
  test('provides translated copy for every shipped locale', () => {
    const english = openCodeProjectImportI18n.en;
    const englishEntries = Object.entries(english);
    for (const locale of locales) {
      const translations = openCodeProjectImportI18n[locale];
      expect(Object.keys(translations).sort()).toEqual(Object.keys(english).sort());
      for (const [key, englishValue] of englishEntries) {
        const value = Object.entries(translations).find(([translatedKey]) => translatedKey === key)?.[1];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(englishValue);
      }
    }
  });
});
