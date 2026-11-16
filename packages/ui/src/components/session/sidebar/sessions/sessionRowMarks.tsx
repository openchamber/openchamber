import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import { sessionGoalMarkLabelKey, sessionGoalStatusColor } from '@/lib/sessionGoalPresentation';
import { cn } from '@/lib/utils';
import { RowMarkTooltip } from './RowMarkTooltip';

export function SessionGoalMark({ goal }: { goal: SessionGoalPayload }): React.ReactNode {
  const { t } = useI18n();
  const sessionGoalLabel = t(sessionGoalMarkLabelKey[goal.status]);
  return (
    <RowMarkTooltip label={sessionGoalLabel}>
      <span className="inline-flex flex-shrink-0 items-center" aria-label={sessionGoalLabel}>
        <Icon name="target" className="h-3 w-3" style={{ color: sessionGoalStatusColor[goal.status] }} />
      </span>
    </RowMarkTooltip>
  );
}

export function PinnedMark(): React.ReactNode {
  const { t } = useI18n();
  const pinnedLabel = t('sessions.sidebar.session.status.pinned');
  return (
    <RowMarkTooltip label={pinnedLabel}>
      <span className="inline-flex flex-shrink-0 items-center" aria-label={pinnedLabel}>
        <Icon name="pushpin" className="h-3 w-3 text-muted-foreground" />
      </span>
    </RowMarkTooltip>
  );
}

export function SessionActionSpinner({ aiRenaming }: { aiRenaming: boolean }): React.ReactNode {
  const { t } = useI18n();
  return (
    <Icon
      name="loader-4"
      className="h-3 w-3 flex-shrink-0 animate-spin text-status-info"
      aria-label={aiRenaming ? t('sessions.aiRename.generating') : t('sessions.sidebar.session.status.movingToWorktree')}
    />
  );
}

// Jev thinks the work looks finished: a quiet check next to the row until a
// new turn starts or the user closes it.
export function DoneHintMark({ className }: { className?: string }): React.ReactNode {
  const { t } = useI18n();
  const doneHintLabel = t('sessions.sidebar.session.work.doneSuggested');
  return (
    <RowMarkTooltip label={doneHintLabel}>
      <span className={cn('inline-flex flex-shrink-0 items-center text-muted-foreground', className)} aria-label={doneHintLabel}>
        <Icon name="check" className="h-3.5 w-3.5" />
      </span>
    </RowMarkTooltip>
  );
}

/** The marks for a request that waits on the user: a permission, a question, or both. */
export function PendingRequestBadges({ hasPermission, hasForm }: { hasPermission: boolean; hasForm: boolean }): React.ReactNode {
  const { t } = useI18n();
  const pendingFormLabel = t('sessions.sidebar.session.status.questionPending');
  const permissionLabel = t('sessions.sidebar.session.status.permissionRequired');
  return (
    <>
      {hasPermission ? (
        <RowMarkTooltip label={permissionLabel}>
          <span className="inline-flex flex-shrink-0 items-center text-status-warning" aria-label={permissionLabel}>
            <Icon name="shield" className="h-3 w-3" />
          </span>
        </RowMarkTooltip>
      ) : null}
      {hasForm ? (
        <RowMarkTooltip label={pendingFormLabel}>
          <span className="inline-flex flex-shrink-0 items-center text-status-warning" aria-label={pendingFormLabel}>
            <Icon name="question" className="h-3 w-3" />
          </span>
        </RowMarkTooltip>
      ) : null}
    </>
  );
}
