import { describe, expect, test } from 'bun:test';

import { subagentsI18n } from './subagents.i18n';

const locales = ['de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
// "Subagents" is the Dutch word too.
const SAME_WORD_KEYS = new Set(['contextPanel.mode.subagents']);

describe('subagent translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = subagentsI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = subagentsI18n[locale];
      expect(Object.keys(translated).sort()).toEqual(keys.slice().sort());
      for (const key of keys) {
        expect(translated[key]?.trim()).toBeTruthy();
        if (!SAME_WORD_KEYS.has(key)) expect(translated[key]).not.toBe(english[key]);
        for (const placeholder of english[key].match(/\{\w+\}/g) ?? []) expect(translated[key]).toContain(placeholder);
      }
    }
  });
});
