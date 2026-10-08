import { describe, expect, test } from 'bun:test';
import { linearIssuePickerI18n } from './linear-issue-picker.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'chat.chatInput.actions.linkLinearIssue',
  'chat.chatInput.linked.linearIssue.openInBrowserAria',
  'chat.chatInput.linked.linearIssue.removeAria',
  'chat.workStatus.linkedIssues.openLinear',
  'session.newWorktree.actions.startFromLinearIssue',
] as const;

describe('linear issue picker translations', () => {
  test('provides every required key in every supported locale', () => {
    const english = linearIssuePickerI18n.en;
    for (const locale of locales) {
      for (const key of requiredKeys) {
        const value = linearIssuePickerI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en') {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });
});
