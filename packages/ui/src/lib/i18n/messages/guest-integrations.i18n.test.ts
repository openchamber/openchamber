import { describe, expect, test } from 'bun:test';

import { guestIntegrationsI18n } from './guest-integrations.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'settings.integrations.guests.title',
  'settings.integrations.guests.info',
  'settings.integrations.guests.status.connected',
  'settings.integrations.guests.status.notConnected',
  'settings.integrations.guests.status.waiting',
  'settings.integrations.guests.actions.connect',
  'settings.integrations.guests.actions.disconnect',
  'settings.integrations.guests.actions.copyRedirect',
  'settings.integrations.guests.actions.copied',
  'settings.integrations.guests.field.clientId',
  'settings.integrations.guests.field.clientSecret',
  'settings.integrations.guests.field.token',
  'settings.integrations.guests.field.token.info',
  'settings.integrations.guests.field.redirectUri',
  'settings.integrations.guests.field.redirectUri.info',
  'settings.integrations.guests.toast.connected',
  'settings.integrations.guests.toast.disconnected',
  'settings.integrations.guests.toast.startFailed',
  'settings.integrations.guests.toast.disconnectFailed',
  'settings.integrations.guests.toast.saveFailed',
  'settings.integrations.guests.toast.authorizationFailed',
  'settings.integrations.guests.toast.clientRequired',
  'settings.integrations.guests.toast.tokenRequired',
  'settings.integrations.guests.toast.tokenInvalid',
] as const;

const allowEnglishLoanword = new Set([
  'settings.integrations.guests.field.clientId',
]);

describe('guest integrations translations', () => {
  test('provides every required key in every locale', () => {
    const english = guestIntegrationsI18n.en;
    for (const locale of locales) {
      for (const key of requiredKeys) {
        const value = guestIntegrationsI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !allowEnglishLoanword.has(key)) {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });
});
