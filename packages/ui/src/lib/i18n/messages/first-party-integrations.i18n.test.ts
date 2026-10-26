import { describe, expect, test } from 'bun:test';
import { firstPartyIntegrationsI18n } from './first-party-integrations.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

// Product names, the same in every language.
const sameAsEnglish = new Set<string>(['settings.integrations.linear.title']);

describe('first-party integration translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = firstPartyIntegrationsI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = firstPartyIntegrationsI18n[locale];
      expect(Object.keys(translated).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        expect(translated[key]).toBeTruthy();
        if (locale !== 'en' && !sameAsEnglish.has(key)) {
          expect(`${locale} ${key}: ${translated[key]}`).not.toBe(`${locale} ${key}: ${english[key]}`);
        }
      }
    }
  });
});
