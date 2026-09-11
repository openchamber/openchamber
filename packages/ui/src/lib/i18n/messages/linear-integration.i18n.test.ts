import { describe, expect, test } from 'bun:test';
import { linearIntegrationI18n } from './linear-integration.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'settings.integrations.firstParty.title',
  'settings.integrations.firstParty.info',
  'settings.integrations.linear.title',
  'settings.integrations.linear.description',
  'settings.integrations.linear.info',
  'settings.integrations.linear.status.notConnected',
  'settings.integrations.linear.status.connected',
  'settings.integrations.linear.status.waiting',
  'settings.integrations.linear.actions.connect',
  'settings.integrations.linear.actions.disconnect',
  'settings.integrations.linear.actions.addWorkspace',
  'settings.integrations.linear.actions.switchTo',
  'settings.integrations.linear.label.otherWorkspaces',
  'settings.integrations.linear.flow.title',
  'settings.integrations.linear.flow.description',
  'settings.integrations.linear.flow.waiting',
  'settings.integrations.linear.toast.connected',
  'settings.integrations.linear.toast.disconnected',
  'settings.integrations.linear.toast.workspaceSwitched',
  'settings.integrations.linear.toast.workspaceSwitchFailed',
  'settings.integrations.linear.toast.startConnectFailed',
  'settings.integrations.linear.toast.disconnectFailed',
  'settings.integrations.linear.toast.authorizationFailed',
  'settings.integrations.linear.avatarAlt.withName',
  'settings.integrations.linear.avatarAlt.fallback',
  'settings.integrations.linear.label.unknownUser',
  'settings.integrations.linear.mapping.defaultProject',
  'settings.integrations.linear.mapping.defaultProject.info',
  'settings.integrations.linear.mapping.defaultProject.placeholder',
  'settings.integrations.linear.mapping.defaultProject.aria',
  'settings.integrations.linear.mapping.teams',
  'settings.integrations.linear.mapping.teams.info',
  'settings.integrations.linear.mapping.teams.useDefault',
  'settings.integrations.linear.mapping.teams.aria',
  'settings.integrations.linear.mapping.emptyProjects',
  'settings.integrations.linear.mapping.emptyTeams',
  'settings.integrations.linear.mapping.loadFailed',
  'settings.integrations.linear.sessionComments.label',
  'settings.integrations.linear.sessionComments.info',
  'settings.integrations.linear.sessionComments.aria',
  'settings.integrations.linear.sessionComments.loadFailed',
  'settings.magicPrompts.sidebar.group.linear',
  'settings.magicPrompts.sidebar.item.linearIssueReview',
  'settings.magicPrompts.page.group.linearIssueReview.title',
  'settings.magicPrompts.page.group.linearIssueReview.description',
] as const;

describe('linear integration translations', () => {
  test('provides every required key in every supported locale', () => {
    const english = linearIntegrationI18n.en;
    for (const locale of locales) {
      for (const key of requiredKeys) {
        const value = linearIntegrationI18n[locale][key];
        expect(value).toBeTruthy();
        if (
          locale !== 'en'
          && key !== 'settings.integrations.linear.title'
          && key !== 'settings.magicPrompts.sidebar.group.linear'
        ) {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });
});
