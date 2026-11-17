import { toast } from '@/components/ui';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { markSessionRead } from '@/sync/notification-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { canSessionBeUnread, markSessionUnread } from '@/sync/session-unread';

export const toggleSessionRead = (
  sessionId: string,
  unread: boolean,
  t: (key: I18nKey, params?: I18nParams) => string,
): void => {
  if (!canSessionBeUnread(useGlobalSessionsStore.getState().entityById.get(sessionId))) return;
  if (unread) {
    markSessionRead(sessionId);
    return;
  }
  void markSessionUnread(sessionId).then((saved) => {
    if (!saved) toast.error(t('sessions.sidebar.session.unread.markFailed'));
  });
};
