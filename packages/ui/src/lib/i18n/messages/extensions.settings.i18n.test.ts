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
  'settings.extensions.dialog.reinstallTitle',
  'settings.extensions.dialog.reinstallDescription',
  'settings.extensions.dialog.reinstall',
  'settings.extensions.toast.added',
  'settings.extensions.toast.reinstalled',
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
  'settings.extensions.service.permissions',
  'settings.extensions.status.needsApproval',
  'settings.extensions.review',
  'settings.extensions.review.aria',
  'settings.extensions.dialog.approveTitle',
  'settings.extensions.dialog.approveDescription',
  'settings.extensions.dialog.approve',
  'settings.extensions.dialog.decline',
  'settings.extensions.capability.prompt',
  'settings.extensions.capability.prompt.detail',
  'settings.extensions.capability.sessions',
  'settings.extensions.capability.sessions.detail',
  'settings.extensions.capability.service',
  'settings.extensions.capability.service.detail',
  'settings.extensions.capability.network',
  'settings.extensions.capability.network.detail',
  'settings.extensions.capability.files',
  'settings.extensions.capability.files.detail',
  'settings.extensions.capability.filesystem',
  'settings.extensions.capability.filesystem.detail',
  'settings.extensions.capability.conversation',
  'settings.extensions.capability.conversation.detail',
  'settings.extensions.toast.approved',
  'settings.extensions.toast.approveFailed',
  'settings.extensions.service.warning',
  'settings.extensions.service.socket.path',
  'settings.extensions.service.socket.path.aria',
  'settings.extensions.service.socket.resolved',
  'settings.extensions.service.socket.unresolved',
  'settings.extensions.service.socket.save',
  'settings.extensions.service.socket.save.aria',
  'settings.extensions.service.socket.clear',
  'settings.extensions.service.socket.clear.aria',
  'settings.extensions.service.socket.edit',
  'settings.extensions.service.socket.edit.aria',
  'settings.extensions.service.socket.cancel',
  'settings.extensions.service.socket.cancel.aria',
  'settings.extensions.toast.socketSaved',
  'settings.extensions.toast.socketSaveFailed',
  'settings.extensions.status.enabled',
  'settings.extensions.status.disabled',
  'settings.extensions.actions.enable',
  'settings.extensions.actions.enable.aria',
  'settings.extensions.actions.disable',
  'settings.extensions.actions.disable.aria',
  'settings.extensions.toast.enabled',
  'settings.extensions.toast.disabled',
  'settings.extensions.toast.enabledFailed',
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
