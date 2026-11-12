import { describe, expect, test } from 'bun:test';

import { fileEditorAidsI18n } from './file-editor-aids.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('files editor aids translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = fileEditorAidsI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const dictionary: Record<string, string> = fileEditorAidsI18n[locale];
      expect(Object.keys(dictionary).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        const value = dictionary[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });

  test('keeps the path placeholder of the import messages', () => {
    for (const locale of locales) {
      expect(fileEditorAidsI18n[locale]['filesView.editor.importNotFound']).toContain('{path}');
      expect(fileEditorAidsI18n[locale]['filesView.editor.importLookupFailed']).toContain('{path}');
    }
  });
});
