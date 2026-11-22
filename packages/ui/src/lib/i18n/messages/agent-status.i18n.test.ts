import { describe, expect, test } from 'bun:test';

import { agentStatusI18n } from './agent-status.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('agent status translations', () => {
  test('every locale has every key, translated and with its placeholders', () => {
    const english = Object.entries(agentStatusI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(agentStatusI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        const text = dictionary.get(key) ?? '';
        expect(text.trim()).toBeTruthy();
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${text}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
        for (const placeholder of englishText.match(/\{(?:name|time|attempt|date)\}/g) ?? []) {
          expect(`${locale} ${key}: ${text}`).toContain(placeholder);
        }
      }
    }
  });

  test('counted phrases cover the locale plural categories', () => {
    for (const locale of locales) {
      const rules = new Intl.PluralRules(locale);
      const categories = new Set(['other', ...rules.resolvedOptions().pluralCategories]);
      for (let count = 2; count <= 120; count += 1) {
        categories.add(rules.select(count));
      }
      for (const [key, text] of Object.entries(agentStatusI18n[locale])) {
        if (!key.endsWith('.count')) continue;
        expect(`${locale} ${key}: ${text}`).toContain('{count, plural,');
        const cases = new Map(
          [...text.matchAll(/\b(zero|one|two|few|many|other)\s*\{([^{}]*)\}/g)]
            .map((match) => [match[1], match[2]]),
        );
        for (const category of categories) {
          expect(`${locale} ${key} ${category}: ${cases.get(category)?.includes('#') ?? 'missing'}`).toBe(`${locale} ${key} ${category}: true`);
        }
      }
    }
  });
});
