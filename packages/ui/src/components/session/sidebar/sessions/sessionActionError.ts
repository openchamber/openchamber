import type { useI18n } from '@/lib/i18n';
import { OpencodeApiError } from '@/lib/opencode/client';

type Translate = ReturnType<typeof useI18n>['t'];

export const describeSessionActionError = (error: Error, t: Translate): string => {
  if (error instanceof OpencodeApiError) {
    if (error.status !== undefined && error.ref) {
      return t('sessions.sidebar.session.action.upstreamErrorWithRef', {
        status: error.status,
        name: error.tag ?? 'Error',
        ref: error.ref,
      });
    }
    if (error.status !== undefined) {
      return t('sessions.sidebar.session.action.upstreamError', {
        status: error.status,
        message: error.detail || error.tag || t('sessions.sidebar.session.action.noDetails'),
      });
    }
  }
  return error.message || t('sessions.sidebar.session.action.noDetails');
};
