import { formatMessage, useI18nStore } from '@/lib/i18n/store';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

type UpdateInstallFailureReason = 'signature' | 'updater-disabled' | 'unknown';

/**
 * Classify a desktop updater install failure. The platform installers report
 * these as opaque English strings, and the two known ones need very different
 * advice from "something went wrong".
 */
export const classifyUpdateInstallError = (error: Error): UpdateInstallFailureReason => {
  const normalized = error.message.toLowerCase();

  if (
    normalized.includes('code signature')
    || normalized.includes('did not pass validation')
    || normalized.includes('code requirement')
    || normalized.includes('not signed')
  ) {
    return 'signature';
  }

  // Squirrel.Mac refuses every later attempt in the same app session once an
  // install failed, so this is a follow-up of an earlier failure.
  if (normalized.includes('command is disabled')) {
    return 'updater-disabled';
  }

  return 'unknown';
};

/**
 * Message for a failed "Restart to Update". Falls back to the raw updater text
 * so an unrecognized failure is still visible rather than silently swallowed.
 */
export const getUpdateInstallErrorMessage = (error: Error): string => {
  const reason = classifyUpdateInstallError(error);

  if (reason === 'signature') {
    return t('updateDialog.error.signatureRejected');
  }

  if (reason === 'updater-disabled') {
    return t('updateDialog.error.updaterDisabled');
  }

  return error.message.trim() || t('updateDialog.error.restartFailed');
};
