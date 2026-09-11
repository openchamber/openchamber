import React from 'react';
import { cn } from '@/lib/utils';
import type { SessionNode } from '../types';
import { useI18n } from '@/lib/i18n';
import { useCollapsedSessionActivityState, type CollapsedActivityState } from './collapsedActivityState';

export function CollapsedActivityIndicator({
  state,
  activeLabel,
  unreadLabel,
  className,
}: {
  state: Exclude<CollapsedActivityState, null>;
  activeLabel: string;
  unreadLabel: string;
  className?: string;
}): React.ReactNode {
  const label = state === 'active' ? activeLabel : unreadLabel;
  // Aggregate rows carry the dot only; the elapsed counter is per session and
  // has no meaning for a collapsed group that may hold several running turns.
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        state === 'active' ? 'bg-primary' : 'bg-[var(--status-info)]',
        className,
      )}
      aria-label={label}
      title={label}
    />
  );
}

export const CollapsedSessionActivityIndicator: React.FC<{ nodes: SessionNode[]; includeUnreadSubtasks: boolean }> = ({ nodes, includeUnreadSubtasks }) => {
  const { t } = useI18n();
  const resolved = useCollapsedSessionActivityState({ nodes, includeUnreadSubtasks });
  if (!resolved) return null;
  return <CollapsedActivityIndicator
    state={resolved}
    activeLabel={t('sessions.sidebar.session.status.active')}
    unreadLabel={t('sessions.sidebar.session.status.unread')}
  />;
};
