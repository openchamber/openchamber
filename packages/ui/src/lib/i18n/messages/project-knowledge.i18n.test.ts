import { describe, expect, test } from 'bun:test';

import { projectKnowledgeI18n } from './project-knowledge.i18n';

const locales = ['en', 'uk', 'de', 'fr', 'es', 'pt-BR', 'nl', 'pl', 'tr', 'ja', 'ko', 'zh-CN', 'zh-TW', 'ar', 'he'] as const;

describe('project knowledge translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(projectKnowledgeI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(projectKnowledgeI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
