import { describe, expect, test } from 'bun:test';

import { sourceBoardI18n } from './source-board.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

// Words a language writes the same as English.
const SAME_AS_ENGLISH = new Map<string, string[]>([
  ['nl', ['sourceBoard.project.label']],
]);

describe('issues and PRs board translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = sourceBoardI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = sourceBoardI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !SAME_AS_ENGLISH.get(locale)?.includes(key)) expect(value).not.toBe(english[key]);
      }
    }
  });
});
