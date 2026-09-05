import React from 'react';
import type { SessionNode } from '../types';
import { useI18n } from '@/lib/i18n';
import { useCollapsedSessionActivityState, type CollapsedActivityState } from './collapsedActivityState';
import { SessionActivityMarker } from './SessionActivityMarker';

export function CollapsedActivityIndicator({
  state,
  activeLabel,
  unreadLabel,
}: {
  state: Exclude<CollapsedActivityState, null>;
  activeLabel: string;
  unreadLabel: string;
}): React.ReactNode {
  const label = state === 'active' ? activeLabel : unreadLabel;
  return (
    <span className="inline-flex size-2.5 shrink-0 items-center justify-center">
      <SessionActivityMarker state={state} label={label} />
    </span>
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
