import { describe, expect, test } from 'bun:test';

import { repositoryDiscussionsI18n } from './repository-discussions.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
// The same word in that language, not a missing translation.
const SAME_AS_ENGLISH = new Set(['fr:references.picker.tab.discussions']);

describe('repository discussion translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = repositoryDiscussionsI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = repositoryDiscussionsI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !SAME_AS_ENGLISH.has(`${locale}:${key}`)) expect(value).not.toBe(english[key]);
      }
    }
  });

  test('keeps the placeholders in every locale', () => {
    for (const locale of locales) {
      const strings: Record<string, string> = repositoryDiscussionsI18n[locale];
      expect(strings['references.picker.discussion.upvotesTitle']).toContain('{count}');
      expect(strings['sourceBoard.discussion.toast.answerFailed']).toContain('{reference}');
      expect(strings['sourceBoard.discussion.toast.unanswerFailed']).toContain('{reference}');
    }
  });
});
