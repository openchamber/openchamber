import React from 'react';

import { cn } from '@/lib/utils';

export function Section({
  title,
  caption,
  subtitle,
  actions,
  children,
}: {
  title: string;
  caption?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div
        className={cn(
          'flex flex-wrap justify-between gap-x-2 gap-y-1',
          subtitle ? 'items-start' : 'items-baseline',
        )}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
          {subtitle ? <span className="truncate typography-micro text-muted-foreground">{subtitle}</span> : null}
        </div>
        {actions ?? (caption ? <span className="truncate typography-micro text-muted-foreground">{caption}</span> : null)}
      </div>
      {children}
    </section>
  );
}
