import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import { sessionGoalMarkLabelKey, sessionGoalStatusColor } from '@/lib/sessionGoalPresentation';
import type { BlockingRequestKind } from '@/sync/session-request-hooks';
import type { PendingRequests } from './usePendingRequests';

export const MobileSessionGoalGlyph: React.FC<{ session: Session }> = ({ session }) => {
  const { t } = useI18n();
  const goal = getSessionGoal(session);
  if (!goal) return null;
  const label = t(sessionGoalMarkLabelKey[goal.status]);
  return (
    <Icon
      name="target"
      className="size-3.5 shrink-0"
      style={{ color: sessionGoalStatusColor[goal.status] }}
      aria-label={label}
    />
  );
};

export const MobileSessionPendingBadges: React.FC<PendingRequests> = ({ hasPermission, hasForm }) => {
  const { t } = useI18n();
  if (!hasPermission && !hasForm) return null;
  return (
    <>
      {hasPermission ? (
        <span
          className="inline-flex shrink-0 items-center text-status-warning"
          aria-label={t('sessions.sidebar.session.status.permissionRequired')}
        >
          <Icon name="shield" className="size-3" />
        </span>
      ) : null}
      {hasForm ? (
        <span
          className="inline-flex shrink-0 items-center text-status-warning"
          aria-label={t('sessions.sidebar.session.status.questionPending')}
        >
          <Icon name="question" className="size-3" />
        </span>
      ) : null}
    </>
  );
};

const BADGE_BUTTON_STYLE: React.CSSProperties = { touchAction: 'manipulation', minHeight: 0, minWidth: 0 };

export const MobileSessionPendingBadgeButtons: React.FC<PendingRequests & {
  onOpen: (kind: BlockingRequestKind) => void;
}> = ({ hasPermission, hasForm, onOpen }) => {
  const { t } = useI18n();
  const badge = (kind: BlockingRequestKind, icon: 'shield' | 'question', label: string) => (
    <button
      type="button"
      data-pending-request-badge={kind}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded text-status-warning before:absolute before:-inset-y-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        kind === 'form' && hasPermission ? 'before:[inset-inline-start:-3px]' : 'before:[inset-inline-start:-0.5rem]',
        kind === 'permission' && hasForm ? 'before:[inset-inline-end:-3px]' : 'before:[inset-inline-end:-0.5rem]',
      )}
      style={BADGE_BUTTON_STYLE}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(kind);
      }}
    >
      <Icon name={icon} className="size-3" />
    </button>
  );
  return (
    <>
      {hasPermission ? badge('permission', 'shield', t('sessions.sidebar.session.status.permissionRequiredOpen')) : null}
      {hasForm ? badge('form', 'question', t('sessions.sidebar.session.status.questionPendingOpen')) : null}
    </>
  );
};
