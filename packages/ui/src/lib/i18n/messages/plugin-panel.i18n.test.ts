import { describe, expect, test } from 'bun:test';

import { pluginPanelI18n } from './plugin-panel.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'contextRail.surface.plugin',
  'contextRail.surface.plugin.description',
  'contextPanel.plugin.loadFailed',
  'contextPanel.plugin.attachDialog.description',
  'contextPanel.plugin.startSession.noProject',
  'contextPanel.plugin.startSession.failed',
  'contextPanel.plugin.startSession.created',
  'contextPanel.plugin.startSession.noModel',
  'contextPanel.plugin.startSession.sendFailed',
  'contextPanel.plugin.prompt.noSession',
  'contextPanel.plugin.prompt.busy',
  'contextPanel.plugin.prompt.noModel',
  'contextPanel.plugin.prompt.sendFailed',
  'contextPanel.plugin.sessionLink.noSession',
  'contextPanel.plugin.sessionLink.failed',
  'contextPanel.plugin.sessionLink.linked',
  'chat.chatInput.linked.guest.openInBrowserAria',
  'chat.chatInput.linked.guest.removeAria',
  'chat.chatInput.linked.guest.pr.number',
  'chat.workStatus.linkedIssues.openGuest',
  'session.newWorktree.actions.startFromGuest',
  'session.newWorktree.fromGuest',
  'session.newWorktree.error.sendGuestContextFailed',
  'contextPanel.plugin.actionDialog.description',
  'contextRail.surface.plugin.badgeAriaSingle',
  'contextRail.surface.plugin.badgeAriaPlural',
  'contextRail.surface.plugin.badgeTooltipSingle',
  'contextRail.surface.plugin.badgeTooltipPlural',
  'chat.chatInput.toast.guestCommandNothing',
  'chat.chatInput.toast.guestCommandFailed',
  'chat.chatInput.toast.guestCommandUnavailable',
] as const;

const sameInEveryLocale = new Set<string>([
  'contextRail.surface.plugin',
  'chat.chatInput.linked.guest.pr.number',
  // "item" is the same word in Portuguese, so the singular forms match English there.
  'contextRail.surface.plugin.badgeAriaSingle',
  'contextRail.surface.plugin.badgeTooltipSingle',
]);

describe('plugin panel translations', () => {
  test('provides every required key in every supported locale', () => {
    const english = pluginPanelI18n.en;
    for (const locale of locales) {
      for (const key of requiredKeys) {
        const value = pluginPanelI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !sameInEveryLocale.has(key)) {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });
});
