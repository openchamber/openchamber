import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type IntegrationCatalogStatusTone = 'success' | 'warning' | 'neutral';

const STATUS_TONE_CLASS = {
  success: 'bg-[var(--status-success)]/15 text-[var(--status-success)]',
  warning: 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
  neutral: 'oc-tile-inset text-muted-foreground',
} satisfies Record<IntegrationCatalogStatusTone, string>;

type IntegrationCatalogCardProps = {
  settingsItem?: string;
  logo: React.ReactNode;
  name: string;
  description: string;
  /** Pills shown before the status pill (bundled, update available). */
  badges?: React.ReactNode;
  status: string;
  statusTone: IntegrationCatalogStatusTone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The expanded body: actions and notes. */
  children: React.ReactNode;
};

/**
 * One collapsible card on the Integrations page: logo, name,
 * one-line description, status pill. Every integration, built-in or from an
 * extension, renders through it, so the cards stay identical.
 */
export const IntegrationCatalogCard: React.FC<IntegrationCatalogCardProps> = ({
  settingsItem,
  logo,
  name,
  description,
  badges,
  status,
  statusTone,
  open,
  onOpenChange,
  children,
}) => (
  <Collapsible open={open} onOpenChange={onOpenChange}>
    <div data-settings-item={settingsItem} className="oc-tile overflow-hidden rounded-xl">
      <CollapsibleTrigger
        className="oc-tile-hover flex w-full min-w-0 items-center gap-3 px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
      >
        <div className="oc-tile-inset flex size-10 shrink-0 items-center justify-center rounded-[10px]">
          {logo}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{name}</div>
          <p className="mt-0.5 truncate text-xs leading-snug text-muted-foreground">{description}</p>
        </div>
        {badges}
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
      {/* The header's own padding plus pt-3 keeps the body clear of the
          header's hover fill. */}
      <CollapsibleContent className="px-4 pb-4 pt-3">
        {children}
      </CollapsibleContent>
    </div>
  </Collapsible>
);
