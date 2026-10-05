import type { I18nKey } from '@/lib/i18n';
import type { InstallGuestErrorCode } from '@/lib/guests/install';
import type { UpdateGuestErrorCode } from '@/lib/guests/updates';

/** Toast text for a failed install, shared by Settings → Extensions and the Integrations catalog cards. */
export const errorToastKey = (code: InstallGuestErrorCode): I18nKey => {
  if (code === 'invalid-path') return 'settings.extensions.toast.invalidPath';
  if (code === 'invalid-url') return 'settings.extensions.toast.invalidUrl';
  if (code === 'not-found') return 'settings.extensions.toast.notFound';
  if (code === 'invalid-manifest') return 'settings.extensions.toast.invalidManifest';
  if (code === 'reserved-id') return 'settings.extensions.toast.reservedId';
  if (code === 'id-taken') return 'settings.extensions.toast.idTaken';
  if (code === 'already-installed') return 'settings.extensions.toast.alreadyInstalled';
  if (code === 'missing-build') return 'settings.extensions.toast.missingBuild';
  if (code === 'host-too-old') return 'settings.extensions.toast.hostTooOld';
  if (code === 'clone-failed') return 'settings.extensions.toast.cloneFailed';
  if (code === 'clone-auth-failed') return 'settings.extensions.toast.cloneNeedsSignIn';
  if (code === 'extract-failed') return 'settings.extensions.toast.extractFailed';
  if (code === 'too-large') return 'settings.extensions.toast.zipTooLarge';
  if (code === 'enterprise-mode') return 'settings.extensions.toast.enterpriseMode';
  return 'settings.extensions.toast.failed';
};

/** Toast text for a failed update. */
export const updateErrorToastKey = (code: UpdateGuestErrorCode): I18nKey => {
  if (code === 'not-git') return 'settings.extensions.toast.notGit';
  if (code === 'enterprise-mode') return 'settings.extensions.toast.enterpriseUpdate';
  if (code === 'clone-failed') return 'settings.extensions.toast.cloneFailed';
  if (code === 'clone-auth-failed') return 'settings.extensions.toast.cloneNeedsSignIn';
  if (code === 'invalid-manifest') return 'settings.extensions.toast.invalidManifest';
  if (code === 'missing-build') return 'settings.extensions.toast.missingBuild';
  if (code === 'swap-failed') return 'settings.extensions.toast.swapFailed';
  if (code === 'not-found') return 'settings.extensions.toast.notFound';
  return 'settings.extensions.toast.updateFailed';
};
