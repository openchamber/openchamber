import type { useI18n } from '@/lib/i18n';
import { OpencodeRequestError } from '@/lib/opencode/upstreamError';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * One sentence a person can act on when a session action fails. An OpenCode
 * failure names the status, the error class and the log ref, because "500"
 * alone sends whoever reads it hunting for a server that is in fact up.
 */
export const describeSessionActionError = (error: Error, t: Translate): string => {
  if (error instanceof OpencodeRequestError) {
    const detail = error.upstream;
    if (detail.status !== undefined && detail.ref) {
      return t('sessions.sidebar.session.action.upstreamErrorWithRef', {
        status: detail.status,
        name: detail.name ?? 'Error',
        ref: detail.ref,
      });
    }
    if (detail.status !== undefined) {
      return t('sessions.sidebar.session.action.upstreamError', {
        status: detail.status,
        message: detail.message ?? detail.name ?? t('sessions.sidebar.session.action.noDetails'),
      });
    }
  }
  return error.message || t('sessions.sidebar.session.action.noDetails');
};
