import React from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { setSessionGoalStatus } from '@/lib/sessionGoalActions';
import { sessionGoalStatusColor } from '@/lib/sessionGoalPresentation';
import { SessionGoalDialog } from '@/components/chat/SessionGoalDialog';
import { WorkStatusRow, WorkStatusRowAction } from './WorkStatusPrimitives';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

/** The session goal, on the mapping every other goal surface uses. */
export const WorkStatusGoalRow: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory ?? undefined);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const handleToggleStatus = React.useCallback(async (nextStatus: 'active' | 'paused') => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      await setSessionGoalStatus(sessionId, directory ?? undefined, nextStatus);
    } catch {
      toast.error(t('chat.workStatus.goal.updateFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, directory, sessionId, t]);

  const objective = enabled && goal ? goal.objective?.trim() || null : null;
  if (!objective || !sessionId) return null;

  // No control while complete: there is nothing left to pause or resume.
  const canPause = goal?.status === 'active';
  const canResume = goal?.status === 'paused'
    || goal?.status === 'blocked'
    || goal?.status === 'budgetLimited';

  return (
    <>
      <WorkStatusRow
        leading={(
          <Icon
            name={goal?.status ? 'target-fill' : 'target'}
            className="size-4 shrink-0"
            style={{ color: goal ? sessionGoalStatusColor[goal.status] : undefined }}
          />
        )}
        label={objective}
        onClick={() => setDialogOpen(true)}
        ariaLabel={t('chat.workStatus.goal.open')}
        value={canPause || canResume ? (
          <WorkStatusRowAction
            tone={canPause ? 'info' : 'warning'}
            disabled={busy}
            ariaLabel={canPause ? t('chat.workStatus.goal.pause') : t('chat.workStatus.goal.resume')}
            onClick={() => { void handleToggleStatus(canPause ? 'paused' : 'active'); }}
          >
            {canPause ? t('chat.workStatus.goal.pause') : t('chat.workStatus.goal.resume')}
          </WorkStatusRowAction>
        ) : undefined}
      />
      <SessionGoalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        sessionId={sessionId}
        directory={directory ?? undefined}
      />
    </>
  );
};
