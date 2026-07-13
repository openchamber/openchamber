import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { DerivedSessionStatus } from './multi-host-sidebar-types';

type HostStatusBadgeProps = {
  status: DerivedSessionStatus;
  count?: number;
  className?: string;
};

function statusConfig(status: DerivedSessionStatus) {
  switch (status) {
    case 'waiting-permission':
      return {
        icon: 'shield' as const,
        label: 'Waiting permission',
        color: 'text-[var(--status-warning)]',
        bgColor: 'bg-[var(--status-warning)]/10',
      };
    case 'waiting-question':
      return {
        icon: 'chat-1' as const,
        label: 'Waiting question',
        color: 'text-[var(--status-info)]',
        bgColor: 'bg-[var(--status-info)]/10',
      };
    case 'error':
      return {
        icon: 'error-warning' as const,
        label: 'Error',
        color: 'text-[var(--status-error)]',
        bgColor: 'bg-[var(--status-error)]/10',
      };
    case 'busy':
      return {
        icon: 'loader-4' as const,
        label: 'Busy',
        color: 'text-primary',
        bgColor: 'bg-primary/10',
      };
    case 'retry':
      return {
        icon: 'refresh' as const,
        label: 'Retrying',
        color: 'text-[var(--status-warning)]',
        bgColor: 'bg-[var(--status-warning)]/10',
      };
    case 'unread':
      return {
        icon: null,
        label: 'Unread',
        color: 'text-[var(--status-info)]',
        bgColor: '',
      };
    case 'idle':
      return {
        icon: null,
        label: 'Idle',
        color: 'text-muted-foreground',
        bgColor: '',
      };
  }
}

export const HostStatusBadge = React.memo(function HostStatusBadge({
  status,
  count,
  className,
}: HostStatusBadgeProps) {
  const config = statusConfig(status);

  if (status === 'unread') {
    return (
      <span
        className={cn('inline-flex items-center', className)}
        aria-label={count ? `${count} unread messages` : 'Unread messages'}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]" />
        {count !== undefined && count > 0 && (
          <span className="ml-1 text-[0.65rem] typography-meta text-[var(--status-info)]">
            {count}
          </span>
        )}
      </span>
    );
  }

  if (status === 'idle') return null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5 text-[0.65rem] typography-meta',
        config.color,
        config.bgColor,
        className,
      )}
      aria-label={config.label}
    >
      {config.icon && (
        <Icon
          name={config.icon}
          className={cn(
            'h-3 w-3',
            status === 'busy' && 'animate-spin',
          )}
        />
      )}
      <span>{config.label}</span>
      {count !== undefined && count > 1 && (
        <span>{count}</span>
      )}
    </span>
  );
});
