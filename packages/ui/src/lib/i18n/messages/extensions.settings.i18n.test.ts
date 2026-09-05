import { describe, expect, test } from 'bun:test';

import { extensionsSettingsI18n } from './extensions.settings.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'settings.page.extensions.title',
  'settings.page.extensions.description',
  'settings.extensions.section.installed',
  'settings.extensions.empty',
  'settings.extensions.unsupported',
  'settings.extensions.source.bundled',
  'settings.extensions.source.path',
  'settings.extensions.source.zip',
  'settings.extensions.source.git',
  'settings.extensions.add.label',
  'settings.extensions.add.placeholder',
  'settings.extensions.add.action',
  'settings.extensions.add.aria',
  'settings.extensions.add.info',
  'settings.extensions.remove',
  'settings.extensions.remove.aria',
  'settings.extensions.toast.added',
  'settings.extensions.toast.removed',
  'settings.extensions.toast.invalidPath',
  'settings.extensions.toast.invalidUrl',
  'settings.extensions.toast.notFound',
  'settings.extensions.toast.invalidManifest',
  'settings.extensions.toast.idTaken',
  'settings.extensions.toast.alreadyInstalled',
  'settings.extensions.toast.missingBuild',
  'settings.extensions.toast.hostTooOld',
  'settings.extensions.toast.cloneFailed',
  'settings.extensions.toast.extractFailed',
  'settings.extensions.toast.failed',
  'settings.extensions.toast.removeFailed',
  'settings.extensions.toast.loadFailed',
  'settings.extensions.agent.allow',
  'settings.extensions.agent.allow.aria',
  'settings.extensions.agent.allowed',
  'settings.extensions.agent.permissions',
  'settings.extensions.toast.agentGranted',
  'settings.extensions.toast.agentGrantFailed',
] as const;

const allowEnglishLoanword = new Set([
  'settings.page.extensions.title',
  'settings.extensions.source.path',
  'settings.extensions.add.placeholder',
]);

describe('extensions settings translations', () => {
  test('provides every required key in every locale', () => {
    const english = extensionsSettingsI18n.en;
    for (const locale of locales) {
      for (const key of requiredKeys) {
        const value = extensionsSettingsI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !allowEnglishLoanword.has(key)) {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });
});
