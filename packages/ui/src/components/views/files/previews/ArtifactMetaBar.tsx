import React from 'react';

import { cn } from '@/lib/utils';

/**
 * The line above an artifact: what the file is, in numbers the user would
 * otherwise have to ask for (size, dimensions, duration, rows). Empty items
 * are dropped so a value that is not known yet leaves no dangling separator.
 */
export const ArtifactMetaBar: React.FC<{
  items: ReadonlyArray<string>;
  actions?: React.ReactNode;
  className?: string;
}> = ({ items, actions, className }) => {
  const shown = items.filter((item) => item.length > 0);
  if (shown.length === 0 && !actions) return null;
  return (
    <div className={cn('flex min-h-7 items-center gap-2 border-b border-border/40 bg-[var(--surface-subtle)] px-3 py-1', className)}>
      <div className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">
        {shown.join(' · ')}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
};
