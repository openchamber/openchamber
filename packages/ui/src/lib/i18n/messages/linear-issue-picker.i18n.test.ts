import { describe, expect, test } from 'bun:test';
import { linearIssuePickerI18n } from './linear-issue-picker.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'chat.chatInput.actions.linkLinearIssue',
  'chat.chatInput.linked.linearIssue.openInBrowserAria',
  'chat.chatInput.linked.linearIssue.removeAria',
  'session.linearIssuePicker.title',
  'session.linearIssuePicker.description',
  'session.linearIssuePicker.searchPlaceholder',
  'session.linearIssuePicker.empty.notConnected',
  'session.linearIssuePicker.empty.runtimeUnavailable',
  'session.linearIssuePicker.empty.noIssuesFound',
  'session.linearIssuePicker.empty.noOpenIssuesFound',
  'session.linearIssuePicker.loading.issues',
  'session.linearIssuePicker.loading.more',
  'session.linearIssuePicker.actions.openSettings',
  'session.linearIssuePicker.actions.useIssue',
  'session.linearIssuePicker.actions.loadMore',
  'session.linearIssuePicker.actions.openInLinearAria',
  'session.linearIssuePicker.toast.loadMoreFailed',
  'session.linearIssuePicker.toast.loadIssueDetailsFailed',
  'session.linearIssuePicker.error.notConnected',
  'session.linearIssuePicker.error.runtimeUnavailable',
  'session.linearIssuePicker.error.issueNotFound',
  'chat.chatInput.actions.newSessionFromLinearIssue',
  'session.linearIssuePicker.title.createSession',
  'session.linearIssuePicker.description.createSession',
  'session.linearIssuePicker.error.noMappedProject',
  'session.linearIssuePicker.error.noModelSelected',
  'session.linearIssuePicker.toast.sendContextFailed',
  'session.linearIssuePicker.toast.sessionCreated',
  'session.linearIssuePicker.toast.startSessionFailed',
  'session.linearIssuePicker.actions.sectionTitle',
  'session.linearIssuePicker.actions.toggleWorktreeAria',
  'session.linearIssuePicker.actions.createInWorktree',
  'session.linearIssuePicker.actions.refresh',
  'chat.workStatus.linkedIssues.openLinear',
  'session.newWorktree.actions.startFromLinearIssue',
  'session.newWorktree.fromLinearIssue',
  'session.newWorktree.error.sendLinearContextFailed',
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
