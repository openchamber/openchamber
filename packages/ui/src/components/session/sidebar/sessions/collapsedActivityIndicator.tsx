import React from 'react';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { SessionPendingMarks } from '@/components/session/SessionPendingMarks';
import type { SessionNode } from '../types';
import { useCollapsedSessionActivityState, type CollapsedActivityState } from './collapsedActivityState';

export function CollapsedActivityIndicator({
  state,
  className,
}: {
  state: Exclude<CollapsedActivityState, null>;
  className?: string;
}): React.ReactNode {
  if (state === 'permission' || state === 'form') {
    return (
      <SessionPendingMarks
        hasPermission={state === 'permission'}
        hasForm={state === 'form'}
        className={className}
        tooltip
      />
    );
  }
  return <SessionActivityIndicator state={state === 'active' ? 'running' : 'unread'} className={className} tooltip />;
}

export const CollapsedSessionActivityIndicator: React.FC<{
  nodes: SessionNode[];
  blockingSessionIds?: readonly string[];
}> = ({ nodes, blockingSessionIds }) => {
  const resolved = useCollapsedSessionActivityState({ nodes, blockingSessionIds });
  if (!resolved) return null;
  return <CollapsedActivityIndicator state={resolved} />;
};
