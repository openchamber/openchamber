import { formatMessage, useI18nStore } from '@/lib/i18n/store';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

const DESKTOP_CHECK_FAILURE_RE = /Unable to check for updates \(([^)]*)\)/;
const NETWORK_CODE_RE = /^(?:ERR_[A-Z_]+|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)$/;
const IPC_PREFIX_RE = /^Error invoking remote method '[^']+': (?:Error: )?/;

export const getUpdateCheckErrorMessage = (error: Error): string => {
  const message = error.message.replace(IPC_PREFIX_RE, '');
  const cause = DESKTOP_CHECK_FAILURE_RE.exec(message)?.[1];
  if (cause === undefined) return message;
  const status = /^HTTP (\d{3})$/.exec(cause)?.[1];
  if (status && status.startsWith('5')) return t('updateDialog.error.checkServerError', { status });
  if (NETWORK_CODE_RE.test(cause)) return t('updateDialog.error.checkOffline');
  return t('updateDialog.error.checkFailed', { detail: cause });
};
