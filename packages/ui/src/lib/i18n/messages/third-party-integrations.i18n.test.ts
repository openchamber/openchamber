import { describe, expect, test } from 'bun:test';
import { thirdPartyIntegrationI18n } from './third-party-integrations.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW'] as const;

const requiredKeys = [
  'settings.page.integrations.title',
  'settings.page.integrations.description',
  'settings.integrations.messengers.title',
  'settings.integrations.messengers.discord.name',
  'settings.integrations.messengers.telegram.name',
  'settings.integrations.thirdParty.title',
  'settings.integrations.thirdParty.actions.install',
  'settings.integrations.thirdParty.actions.update',
  'settings.integrations.thirdParty.actions.setup',
  'settings.integrations.thirdParty.actions.remove',
  'settings.integrations.thirdParty.status.notInstalled',
  'settings.integrations.thirdParty.opencodeClaude.description',
  'settings.integrations.thirdParty.opencodeCommandcode.description',
  'settings.integrations.thirdParty.opencodeCursorOauth.description',
] as const;

describe('third-party integration translations', () => {
  test('provides every required key in every supported locale', () => {
    for (const locale of locales) {
      for (const key of requiredKeys) {
        expect(thirdPartyIntegrationI18n[locale][key]).toBeTruthy();
      }
    }
  });
});
