import { toast } from '@/components/ui';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { markSessionRead } from '@/sync/notification-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { canSessionBeUnread, markSessionUnread } from '@/sync/session-unread';

/** Mark as read when the session is unread, Mark as unread otherwise. */
export const toggleSessionRead = (
  sessionId: string,
  unread: boolean,
  t: (key: I18nKey, params?: I18nParams) => string,
): void => {
  // Subsessions and archived sessions carry no unread mark.
  if (!canSessionBeUnread(useGlobalSessionsStore.getState().entityById.get(sessionId))) return;
  if (unread) {
    markSessionRead(sessionId);
    return;
  }
  void markSessionUnread(sessionId).then((saved) => {
    if (!saved) toast.error(t('sessions.sidebar.session.unread.markFailed'));
  });
};
