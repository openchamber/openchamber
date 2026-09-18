import React from 'react';
import { cn } from '@/lib/utils';
import type { SessionNode } from '../types';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { useCollapsedSessionActivityState, type CollapsedActivityState } from './collapsedActivityState';

// Aggregate rows carry no counters: the elapsed counter is per session and
// has no meaning for a collapsed group that may hold several running turns,
// and a request count would need the same per-session breakdown. The blocked
// states reuse the session row's own badge glyphs and colors so the group
// header reads the same way as the row it hides.
export function CollapsedActivityIndicator({
  state,
  className,
}: {
  state: Exclude<CollapsedActivityState, null>;
  className?: string;
}): React.ReactNode {
  const { t } = useI18n();
  if (state === 'permission' || state === 'question') {
    const label = state === 'permission'
      ? t('sessions.sidebar.session.status.permissionRequired')
      : t('sessions.sidebar.session.status.questionPending');
    return (
      <span
        className={cn('inline-flex shrink-0 items-center', state === 'permission' ? 'text-destructive' : 'text-status-info', className)}
        aria-label={label}
        title={label}
      >
        <Icon name={state === 'permission' ? 'shield' : 'question'} className="h-3 w-3" />
      </span>
    );
  }
  const label = state === 'active'
    ? t('sessions.sidebar.session.status.active')
    : t('sessions.sidebar.session.status.unread');
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
  const resolved = useCollapsedSessionActivityState({ nodes, includeUnreadSubtasks });
  if (!resolved) return null;
  return <CollapsedActivityIndicator state={resolved} />;
};
