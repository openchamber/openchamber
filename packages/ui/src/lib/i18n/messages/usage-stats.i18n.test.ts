import { describe, expect, test } from 'bun:test';

import { usageStatsI18n } from './usage-stats.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

// Words that are the correct translation and happen to match English.
const SAME_AS_ENGLISH = new Set(['Sessions', 'Prompts', 'Tokens', 'Tokens: {tokens} · {cost}', '{value} · {share}']);

describe('stats page translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english = usageStatsI18n.en;
    // SAFETY: `english` is a const literal, so its own keys are exactly `keyof typeof english`.
    const keys = Object.keys(english) as Array<keyof typeof english>;
    for (const locale of locales) {
      expect(Object.keys(usageStatsI18n[locale]).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        const value = usageStatsI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !SAME_AS_ENGLISH.has(english[key])) expect(value).not.toBe(english[key]);
      }
    }
  });
});
