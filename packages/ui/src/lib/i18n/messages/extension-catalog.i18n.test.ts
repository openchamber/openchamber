import { describe, expect, test } from 'bun:test';
import { extensionCatalogI18n } from './extension-catalog.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

describe('extension catalog translations', () => {
  test('every locale has exactly the English keys, each translated', () => {
    const keys = Object.keys(extensionCatalogI18n.en).sort();
    for (const locale of locales) {
      const dictionary: Record<string, string> = extensionCatalogI18n[locale];
      expect(Object.keys(dictionary).sort()).toEqual(keys);
      for (const key of keys) expect(dictionary[key]).toBeTruthy();
    }
  });
});
