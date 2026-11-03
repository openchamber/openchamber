import { describe, expect, test } from 'bun:test';

import { sidebarSectionsI18n } from './sidebar-sections.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
// Words those languages take from English as they are: git and forge terms, and a few words spelled the same.
const SHARED_WITH_ENGLISH = new Map(Object.entries({
  de: new Set(['sessions.sidebar.sections.link.plan', 'sessions.sidebar.pinTo.newListName', 'sessions.sidebar.sections.name', 'sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.kind.space', 'sessions.sidebar.sections.link.issue']),
  fr: new Set(['sessions.sidebar.sections.link.plan', 'sessions.sidebar.sections.open', 'sessions.sidebar.sections.template.prs', 'sessions.sidebar.sections.kind.session', 'sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.link.pr']),
  nl: new Set(['sessions.sidebar.sections.link.plan', 'sessions.sidebar.sections.template.prs', 'sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.kind.space', 'sessions.sidebar.sections.kind.run', 'sessions.sidebar.sections.link.pr', 'sessions.sidebar.sections.link.issue', 'sessions.sidebar.sections.matchWorksSingle', 'sessions.sidebar.sections.matchWorksPlural', 'sessions.sidebar.sections.matchProjectsSingle']),
  es: new Set(['sessions.sidebar.sections.link.plan', 'sessions.sidebar.sections.template.prs', 'sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.link.pr', 'sessions.sidebar.sections.link.issue']),
  ja: new Set(['sessions.sidebar.sections.link.issue']),
  'pt-BR': new Set(['sessions.sidebar.sections.template.prs', 'sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.link.pr', 'sessions.sidebar.sections.link.issue', 'sessions.sidebar.sections.matchWorksSingle']),
  uk: new Set(['sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.link.pr', 'sessions.sidebar.sections.link.issue']),
  pl: new Set(['sessions.sidebar.sections.link.plan', 'sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.link.pr']),
  tr: new Set(['sessions.sidebar.sections.link.plan', 'sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.link.pr', 'sessions.sidebar.sections.link.issue']),
  he: new Set(['sessions.sidebar.sections.kind.worktree', 'sessions.sidebar.sections.link.issue']),
}));

describe('sidebar sections translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(sidebarSectionsI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(sidebarSectionsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en' && !SHARED_WITH_ENGLISH.get(locale)?.has(key)) {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
