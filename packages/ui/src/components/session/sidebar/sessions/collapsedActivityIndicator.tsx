import React from 'react';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { cn } from '@/lib/utils';
import type { SessionNode } from '../types';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { useCollapsedSessionActivityState, type CollapsedActivityState } from './collapsedActivityState';
import { RowMarkTooltip } from './RowMarkTooltip';

export function CollapsedActivityIndicator({
  state,
  className,
}: {
  state: Exclude<CollapsedActivityState, null>;
  className?: string;
}): React.ReactNode {
  const { t } = useI18n();
  if (state === 'permission' || state === 'form') {
    const label = state === 'permission'
      ? t('sessions.sidebar.session.status.permissionRequired')
      : t('sessions.sidebar.session.status.questionPending');
    return (
      <RowMarkTooltip label={label}>
        <span
          className={cn('inline-flex shrink-0 items-center text-status-warning', className)}
          aria-label={label}
        >
          <Icon name={state === 'permission' ? 'shield' : 'question'} className="h-3 w-3" />
        </span>
      </RowMarkTooltip>
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
