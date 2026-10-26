import { describe, expect, test } from 'bun:test';

import { fileContentSearchI18n } from './file-content-search.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('find in files translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = fileContentSearchI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const dictionary: Record<string, string> = fileContentSearchI18n[locale];
      expect(Object.keys(dictionary).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        const value = dictionary[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });

  test('keeps the placeholders of every parameterised message', () => {
    for (const locale of locales) {
      expect(fileContentSearchI18n[locale]['sidebarFilesTree.contentSearch.limit']).toContain('{count}');
      expect(fileContentSearchI18n[locale]['sidebarFilesTree.contentSearch.failed']).toContain('{message}');
    }
  });
});
