import { describe, expect, test } from 'bun:test';
import { linearIssuePickerI18n } from './linear-issue-picker.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'chat.chatInput.actions.linkTrackerItem',
  'chat.chatInput.linked.trackerItem.openInBrowserAria',
  'chat.chatInput.linked.trackerItem.removeAria',
  'chat.workStatus.linkedIssues.openTrackerItem',
  'session.newWorktree.actions.startFromTrackerItem',
] as const;

describe('tracker item picker translations', () => {
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
