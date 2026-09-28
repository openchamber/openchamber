import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type IntegrationCatalogStatusTone = 'success' | 'warning' | 'neutral';

const STATUS_TONE_CLASS = {
  success: 'bg-[var(--status-success)]/15 text-[var(--status-success)]',
  warning: 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
  neutral: 'bg-[var(--surface-muted)] text-muted-foreground',
} satisfies Record<IntegrationCatalogStatusTone, string>;

type IntegrationCatalogCardProps = {
  settingsItem: string;
  logo: React.ReactNode;
  name: string;
  description: string;
  status: string;
  statusTone: IntegrationCatalogStatusTone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The expanded body: actions and notes. */
  children: React.ReactNode;
};

/** One collapsible card on the Integrations page: logo, name, one-line description, status pill. */
export const IntegrationCatalogCard: React.FC<IntegrationCatalogCardProps> = ({
  settingsItem,
  logo,
  name,
  description,
  status,
  statusTone,
  open,
  onOpenChange,
  children,
}) => (
  <Collapsible open={open} onOpenChange={onOpenChange}>
    <div
      data-settings-item={settingsItem}
      className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]"
    >
      <CollapsibleTrigger
        className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
          {logo}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{name}</div>
          <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">{description}</p>
        </div>
        <span
          aria-live="polite"
          className={cn('max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium', STATUS_TONE_CLASS[statusTone])}
        >
          {status}
        </span>
        <Icon
          name="arrow-down-s"
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-4">
        {children}
      </CollapsibleContent>
    </div>
  </Collapsible>
);
