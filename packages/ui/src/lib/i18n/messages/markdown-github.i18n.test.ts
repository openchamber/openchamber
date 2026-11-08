import { describe, expect, test } from 'bun:test';

import { markdownGithubI18n } from './markdown-github.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
// The same word in English and in the locale, as GitHub's own translations write it.
const sameAsEnglish = new Set(['fr:chat.markdown.alert.important', 'nl:chat.markdown.alert.tip']);

describe('GitHub Markdown extras translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = markdownGithubI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = markdownGithubI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        expect(translated[key]).toBeTruthy();
        if (locale !== 'en' && !sameAsEnglish.has(`${locale}:${key}`)) expect(translated[key]).not.toBe(english[key]);
      }
    }
  });
});
