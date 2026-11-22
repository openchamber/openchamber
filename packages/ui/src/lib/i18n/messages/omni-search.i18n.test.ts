import { describe, expect, test } from 'bun:test';

import { omniSearchI18n } from './omni-search.i18n';

type Dictionary = Record<string, string>;

// SAFETY: Object.keys of the literal `omniSearchI18n` object returns exactly its own locale keys.
const locales = Object.keys(omniSearchI18n) as Array<keyof typeof omniSearchI18n>;
const english: Dictionary = omniSearchI18n.en;

const placeholdersOf = (text: string): string[] => (text.match(/\{[^{}]+\}/g) ?? []).sort();

describe('omni search dictionary', () => {
  test('every locale defines exactly the English keys', () => {
    const englishKeys = Object.keys(english).sort();
    for (const locale of locales) {
      expect(Object.keys(omniSearchI18n[locale]).sort()).toEqual(englishKeys);
    }
  });

  test('no omni search string joins facts with an ASCII-style separator', () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(omniSearchI18n[locale])) {
        expect(`${locale} ${key}: ${/[·•|]/.test(text)}`).toBe(`${locale} ${key}: false`);
      }
    }
  });

  test('every locale keeps each key placeholder names identical to English', () => {
    for (const locale of locales) {
      const translated: Dictionary = omniSearchI18n[locale];
      for (const key of Object.keys(english)) {
        expect(`${locale} ${key}: ${placeholdersOf(translated[key]).join(' ')}`).toBe(
          `${locale} ${key}: ${placeholdersOf(english[key]).join(' ')}`,
        );
      }
    }
  });
});
