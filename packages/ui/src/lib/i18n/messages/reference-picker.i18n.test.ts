import { describe, expect, test } from 'bun:test';

import { referencePickerI18n } from './reference-picker.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

// Words these languages use as is, so the translation is the English word.
const sameAsEnglish = {
  de: ['references.picker.tab.issues', 'references.picker.preview.team', 'references.picker.preview.branch', 'references.picker.preview.checks', 'references.picker.preview.review', 'references.picker.preview.labels'],
  fr: ['references.picker.tab.issues', 'references.picker.tab.pulls', 'references.picker.preview.labels'],
  nl: ['references.picker.tab.issues', 'references.picker.tab.pulls', 'references.picker.filter.open', 'references.picker.state.open', 'references.picker.preview.team', 'references.picker.preview.branch', 'references.picker.preview.checks', 'references.picker.preview.review', 'references.picker.preview.labels'],
  es: ['references.picker.tab.issues', 'references.picker.tab.pulls'],
  'pt-BR': ['references.picker.tab.issues', 'references.picker.tab.pulls', 'references.picker.preview.branch'],
  uk: ['references.picker.tab.issues', 'references.picker.tab.pulls'],
  pl: ['references.picker.tab.issues', 'references.picker.preview.review'],
} satisfies Partial<Record<(typeof locales)[number], readonly string[]>>;

const allowedSame = (locale: string): readonly string[] => Object.entries(sameAsEnglish).find(([name]) => name === locale)?.[1] ?? [];

describe('reference picker translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(referencePickerI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(referencePickerI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en' && !allowedSame(locale).includes(key)) {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });

  test('placeholders survive translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(referencePickerI18n[locale]));
      for (const [key, englishText] of Object.entries(referencePickerI18n.en)) {
        expect(`${locale} ${key} ${placeholders(dictionary.get(key) ?? '').join(',')}`)
          .toBe(`${locale} ${key} ${placeholders(englishText).join(',')}`);
      }
    }
  });
});
