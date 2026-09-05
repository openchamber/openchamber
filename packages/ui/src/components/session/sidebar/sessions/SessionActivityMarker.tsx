import React from 'react';
import { cn } from '@/lib/utils';

export const SessionActivityMarker: React.FC<{
  state: 'active' | 'unread';
  label: string;
  decorative?: boolean;
  className?: string;
}> = ({ state, label, decorative = false, className }) => {
  return (
    <span
      role={decorative ? undefined : 'img'}
      className={cn(
        'inline-block shrink-0 rounded-full',
        state === 'active'
          ? 'size-2.5 border-2 border-primary'
          : 'size-1.5 bg-[var(--status-info)]',
        className,
      )}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      title={decorative ? undefined : label}
    />
  );
};
