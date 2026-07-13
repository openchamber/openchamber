import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { HostSessionRef, HostSessionSummary } from '@/multi-host';
import type { DerivedSessionStatus, SessionExtraStatus } from './multi-host-sidebar-types';
import { HostStatusBadge } from './HostStatusBadge';

type HostSessionNodeProps = {
  ref: HostSessionRef;
  session: HostSessionSummary;
  derivedStatus: DerivedSessionStatus;
  unreadCount: number;
  isActive: boolean;
  isPending: boolean;
  extra?: SessionExtraStatus;
  onActivate: (ref: HostSessionRef) => void;
};

function formatRelativeTime(updatedAt?: number): string {
  if (!updatedAt) return '';
  const diff = Date.now() - updatedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const HostSessionNode = React.memo(function HostSessionNode({
  ref: hostSessionRef,
  session,
  derivedStatus,
  unreadCount,
  isActive,
  isPending,
  onActivate,
}: HostSessionNodeProps) {
  const handleClick = React.useCallback(() => {
    onActivate(hostSessionRef);
  }, [onActivate, hostSessionRef]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate(hostSessionRef);
      }
    },
    [onActivate, hostSessionRef],
  );

  const title = session.title || 'Untitled session';
  const timeLabel = formatRelativeTime(session.updatedAt);

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm',
        'hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        isActive && 'bg-[var(--interactive-selection)] text-primary',
        !isActive && 'text-foreground',
        isPending && 'pointer-events-none opacity-60',
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-current={isActive ? 'true' : undefined}
      aria-busy={isPending || undefined}
      data-session-row={`${hostSessionRef.hostId}:${hostSessionRef.sessionId}`}
    >
      {/* Leading status indicator */}
      <span className="flex w-4 shrink-0 items-center justify-center">
        {isPending ? (
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-busy-pulse" />
        ) : derivedStatus === 'busy' ? (
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-busy-pulse" />
        ) : derivedStatus === 'unread' ? (
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]" />
        ) : derivedStatus === 'waiting-permission' ? (
          <Icon name="shield" className="h-3 w-3 text-[var(--status-warning)]" />
        ) : derivedStatus === 'waiting-question' ? (
          <Icon name="chat-1" className="h-3 w-3 text-[var(--status-info)]" />
        ) : derivedStatus === 'error' ? (
          <Icon name="error-warning" className="h-3 w-3 text-[var(--status-error)]" />
        ) : derivedStatus === 'retry' ? (
          <Icon name="refresh" className="h-3 w-3 text-[var(--status-warning)]" />
        ) : null}
      </span>

      {/* Title */}
      <span
        className={cn(
          'block min-w-0 flex-1 truncate typography-ui-label font-normal',
          isActive ? 'text-primary' : 'text-foreground',
        )}
      >
        {title}
      </span>

      {/* Status badge (non-idle, non-unread) */}
      {derivedStatus !== 'idle' && derivedStatus !== 'unread' && (
        <HostStatusBadge status={derivedStatus} className="shrink-0" />
      )}

      {/* Unread badge */}
      {derivedStatus === 'unread' && unreadCount > 0 && (
        <HostStatusBadge
          status="unread"
          count={unreadCount}
          className="shrink-0"
        />
      )}

      {/* Relative time */}
      {timeLabel && (
        <span className="shrink-0 text-[0.6rem] typography-meta text-muted-foreground opacity-0 group-hover:opacity-100">
          {timeLabel}
        </span>
      )}
    </button>
  );
});
