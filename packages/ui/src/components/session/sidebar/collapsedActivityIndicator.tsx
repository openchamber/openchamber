import React from 'react';
import { cn } from '@/lib/utils';
import type { CollapsedActivityState } from './collapsedActivityState';

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
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        state === 'active' ? 'bg-primary animate-busy-pulse' : 'bg-[var(--status-info)]',
        className,
      )}
      aria-label={label}
      title={label}
    />
  );
}
