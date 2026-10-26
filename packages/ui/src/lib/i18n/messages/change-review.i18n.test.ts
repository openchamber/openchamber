import { describe, expect, test } from 'bun:test';

import { changeReviewI18n } from './change-review.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

// Words these languages use as is, so the translation is the English word.
const sameAsEnglish = {
  de: ['references.picker.preview.revision.label', 'references.picker.preview.revision.number', 'references.picker.preview.revision.kind.trivialRebase', 'gitView.change.push.optional', 'gitView.change.push.hashtags'],
  fr: ['sourceBoard.vote.label', 'references.picker.preview.revision.label', 'references.picker.preview.revision.number', 'references.picker.preview.revision.kind.trivialRebase', 'gitView.change.push.hashtags'],
  nl: ['references.picker.preview.revision.label', 'references.picker.preview.revision.number', 'references.picker.preview.revision.kind.trivialRebase', 'gitView.change.push.hashtags'],
  es: ['references.picker.preview.revision.label', 'references.picker.preview.revision.number', 'references.picker.preview.revision.kind.trivialRebase', 'gitView.change.push.hashtags'],
  'pt-BR': ['references.picker.preview.revision.label', 'references.picker.preview.revision.number', 'references.picker.preview.revision.kind.trivialRebase', 'gitView.change.push.hashtags'],
  pl: ['references.picker.preview.revision.kind.trivialRebase'],
  tr: ['references.picker.preview.revision.kind.trivialRebase'],
  'zh-TW': ['references.picker.preview.revision.kind.trivialRebase'],
  he: ['references.picker.preview.revision.kind.trivialRebase'],
} satisfies Partial<Record<(typeof locales)[number], readonly string[]>>;

// Only placeholders, the same in every language.
const literal = new Set<string>(['sourceBoard.vote.byUser']);

const allowedSame = (locale: string): readonly string[] => Object.entries(sameAsEnglish).find(([name]) => name === locale)?.[1] ?? [];

describe('change review translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(changeReviewI18n.en);
    expect(english.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(changeReviewI18n[locale]));
      expect([...dictionary.keys()]).toEqual(english.map(([key]) => key));
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en' && !literal.has(key) && !allowedSame(locale).includes(key)) {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });

  test('placeholders survive translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(changeReviewI18n[locale]));
      for (const [key, englishText] of Object.entries(changeReviewI18n.en)) {
        expect(`${locale} ${key} ${placeholders(dictionary.get(key) ?? '').join(',')}`)
          .toBe(`${locale} ${key} ${placeholders(englishText).join(',')}`);
      }
    }
  });

  // The review host's own words and menu paths are not translated.
  test('Change-Id and the host menu paths stay literal', () => {
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(changeReviewI18n[locale]));
      for (const [key, englishText] of Object.entries(changeReviewI18n.en)) {
        for (const literalText of ['Change-Id', 'commit-msg', 'Settings → Profile', 'Settings → HTTP Credentials']) {
          if (englishText.includes(literalText)) {
            expect(`${locale} ${key}: ${dictionary.get(key)?.includes(literalText)}`).toBe(`${locale} ${key}: true`);
          }
        }
      }
    }
  });
});
