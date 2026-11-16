import React from 'react';
import { cn } from '@/lib/utils';

/** The minus sign of a removed-line count: a true minus, as wide as the plus. */
const MINUS = '−';

/**
 * A diff's line counts, written one way across the app: `+12 −2`, added in
 * the success colour and removed in the error colour, a space between them,
 * figures of equal width. `hideZero` leaves out a side with nothing to say,
 * for rows where width is short; with both sides zero it renders nothing.
 * Size and placement come from the caller's `className`.
 */
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
    // The gap draws the space; the space itself, which a flex box leaves out
    // of layout, stays in the text, so copying and screen readers get "+12 −2".
    <span className={cn('inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap tabular-nums', className)}>
      {showAdded ? <span className="text-[var(--status-success)]">+{added}</span> : null}
      {showAdded && showRemoved ? ' ' : null}
      {showRemoved ? <span className="text-[var(--status-error)]">{MINUS}{removed}</span> : null}
    </span>
  );
}
