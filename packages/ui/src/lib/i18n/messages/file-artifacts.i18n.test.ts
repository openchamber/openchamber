import { describe, expect, test } from 'bun:test';

import { fileArtifactsI18n } from './file-artifacts.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

describe('file artifact translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english = fileArtifactsI18n.en;
    const keys = Object.keys(english) as Array<keyof typeof english>;
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      for (const key of keys) {
        const value = fileArtifactsI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });
});
