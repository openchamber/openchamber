import { toast } from '@/components/ui';
import type { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { leaveFinishedSessions } from '@/lib/sessionTabs';
import { setSessionWorkState } from '@/sync/session-actions';
import { settleRunningOperatorChildren } from '@/sync/operator-children-done';
import { normalizePath } from '../utils';

export const toggleSessionWork = async (
  sessionId: string,
  directory: string | null,
  inWork: readonly Session[],
  t: ReturnType<typeof useI18n>['t'],
): Promise<void> => {
  try {
    if (inWork.length === 0) {
      await setSessionWorkState(sessionId, directory, 'open');
      return;
    }
    if (!await settleRunningOperatorChildren(inWork.map((entry) => entry.id))) return;
    for (const entry of inWork) {
      await setSessionWorkState(entry.id, normalizePath(entry.directory ?? null) ?? directory, 'done');
    }
    leaveFinishedSessions(inWork.map((entry) => entry.id));
  } catch {
    toast.error(t('sessions.sidebar.session.work.updateFailed'));
  }
};
