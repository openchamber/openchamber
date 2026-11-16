import { describe, expect, test } from 'bun:test';
import { extensionPowersI18n } from './extension-powers.i18n';

describe('extension powers translations', () => {
  test('every locale has exactly the English keys, each translated', () => {
    const english: Record<string, string> = extensionPowersI18n.en;
    const keys = Object.keys(english).sort();
    for (const [locale, dictionary] of Object.entries(extensionPowersI18n)) {
      expect(Object.keys(dictionary).sort()).toEqual(keys);
      if (locale === 'en') continue;
      const entries: Record<string, string> = dictionary;
      expect(keys.some((key) => entries[key] !== english[key])).toBe(true);
    }
  });
});
