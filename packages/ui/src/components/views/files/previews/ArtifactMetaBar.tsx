import React from 'react';

import { cn } from '@/lib/utils';

/**
 * The line above an artifact: what the file is, in numbers the user would
 * otherwise have to ask for (size, dimensions, duration, rows). Empty items
 * are dropped so a value that is not known yet leaves no dangling separator.
 */
export const ArtifactMetaBar: React.FC<{
  items: ReadonlyArray<string>;
  /** Comes first and stands out: what the user is on, as opposed to facts about the file. */
  lead?: string;
  /** What is happening now. Stays whole when the line runs out of room. */
  status?: string;
  /** Says more about `status` on hover. */
  hint?: string;
  actions?: React.ReactNode;
  className?: string;
}> = ({ items, lead, status, hint, actions, className }) => {
  const shown = items.filter((item) => item.length > 0);
  if (shown.length === 0 && !lead && !status && !actions) return null;
  return (
    <div className={cn('flex min-h-7 items-center gap-2 border-b border-edge-muted bg-[var(--surface-subtle)] px-3 py-1', className)}>
      <div className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">
        {lead ? <span className="text-foreground">{lead}</span> : null}
        {lead && shown.length > 0 ? ' · ' : ''}
        {shown.join(' · ')}
      </div>
      {status ? <div className="max-w-[60%] shrink-0 truncate typography-meta text-muted-foreground" title={hint}>{status}</div> : null}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
};
