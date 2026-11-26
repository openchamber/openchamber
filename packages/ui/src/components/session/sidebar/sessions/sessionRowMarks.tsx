import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import { sessionGoalMarkLabelKey, sessionGoalStatusColor } from '@/lib/sessionGoalPresentation';
import { cn } from '@/lib/utils';
import { RowMarkTooltip } from './RowMarkTooltip';
import { handleRowActionMouseDown, handleRowActionPointerDown } from './sessionRowActionEvents';

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

type PendingRequestBadgeKind = 'permission' | 'form';

const PENDING_REQUEST_BADGES = [
  { kind: 'permission', icon: 'shield', labelKey: 'sessions.sidebar.session.status.permissionRequired', openLabelKey: 'sessions.sidebar.session.status.permissionRequiredOpen' },
  { kind: 'form', icon: 'question', labelKey: 'sessions.sidebar.session.status.questionPending', openLabelKey: 'sessions.sidebar.session.status.questionPendingOpen' },
] as const;

const BADGE_BUTTON_STYLE: React.CSSProperties = { minHeight: 0, minWidth: 0 };

export function PendingRequestBadges({ hasPermission, hasForm, onOpen }: {
  hasPermission: boolean;
  hasForm: boolean;
  onOpen?: (kind: PendingRequestBadgeKind, target: HTMLElement) => void;
}): React.ReactNode {
  const { t } = useI18n();
  return PENDING_REQUEST_BADGES.map(({ kind, icon, labelKey, openLabelKey }) => {
    if (!(kind === 'permission' ? hasPermission : hasForm)) return null;
    if (!onOpen) {
      const label = t(labelKey);
      return (
        <RowMarkTooltip key={kind} label={label}>
          <span className="inline-flex flex-shrink-0 items-center text-status-warning" aria-label={label}>
            <Icon name={icon} className="h-3 w-3" />
          </span>
        </RowMarkTooltip>
      );
    }
    const label = t(openLabelKey);
    return (
      <RowMarkTooltip key={kind} label={label}>
        <button
          type="button"
          data-pending-request-badge={kind}
          className="relative inline-flex flex-shrink-0 cursor-pointer items-center rounded text-status-warning before:absolute before:-inset-1 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={BADGE_BUTTON_STYLE}
          aria-label={label}
          onPointerDown={handleRowActionPointerDown}
          onMouseDown={handleRowActionMouseDown}
          onKeyDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpen(kind, event.currentTarget);
          }}
        >
          <Icon name={icon} className="h-3 w-3" />
        </button>
      </RowMarkTooltip>
    );
  });
}
