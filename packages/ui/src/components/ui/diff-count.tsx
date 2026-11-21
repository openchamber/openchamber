import React from 'react';
import { cn } from '@/lib/utils';

const MINUS = '−';

export function DiffCount({ added, removed, hideZero = false, className }: {
  added: number;
  removed: number;
  hideZero?: boolean;
  className?: string;
}): React.ReactNode {
  const showAdded = !hideZero || added > 0;
  const showRemoved = !hideZero || removed > 0;
  if (!showAdded && !showRemoved) return null;
  return (
    <span className={cn('inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap tabular-nums', className)}>
      {showAdded ? <span className="text-[var(--status-success)]">+{added}</span> : null}
      {showAdded && showRemoved ? ' ' : null}
      {showRemoved ? <span className="text-[var(--status-error)]">{MINUS}{removed}</span> : null}
    </span>
  );
}
