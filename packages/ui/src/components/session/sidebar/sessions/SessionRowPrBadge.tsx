import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn } from '@/lib/utils';
import { SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS, SidebarRefLinks } from './SidebarRefLinks';
import { handleRowActionMouseDown, handleRowActionPointerDown } from './sessionRowActionEvents';
import type { SessionRefLine } from './useSessionRefLines';

type SessionRowPrBadgeProps = {
  primaryRef: SessionRefLine;
  refLines: readonly SessionRefLine[];
  moreRefCount: number;
  isOneLineTimelineRow: boolean;
  trackerDirectory: string | null;
};

export function SessionRowPrBadge({
  primaryRef,
  refLines,
  moreRefCount,
  isOneLineTimelineRow,
  trackerDirectory,
}: SessionRowPrBadgeProps): React.ReactNode {
  const openTrackerItem = useOpenTrackerItem();
  const refBadgeLabel = refLines.map((line) => line.text).join(', ');
  return (
    <Tooltip>
      <TooltipTrigger asChild closeDelay={SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS}>
        <button
          type="button"
          className={cn(
            'inline-flex flex-shrink-0 items-center gap-1 rounded typography-micro text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:no-underline',
          )}
          disabled={!primaryRef.url}
          aria-label={refBadgeLabel}
          onPointerDown={handleRowActionPointerDown}
          onMouseDown={handleRowActionMouseDown}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.target instanceof Element && event.target.closest('[data-ref-more]')) return;
            if (primaryRef.url) openTrackerItem(primaryRef.url, trackerDirectory, event);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Icon name={primaryRef.icon} className={cn('h-3 w-3', primaryRef.color && 'oc-ref-tint')} style={primaryRef.color ? refTintStyle(primaryRef.color) : undefined} />
          {isOneLineTimelineRow ? null : <>
            <span className="leading-none tabular-nums">{primaryRef.label}</span>
            {moreRefCount > 0 ? <span data-ref-more className="leading-none tabular-nums text-muted-foreground">+{moreRefCount}</span> : null}
          </>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-xs">
        <SidebarRefLinks items={refLines} directory={trackerDirectory} />
      </TooltipContent>
    </Tooltip>
  );
}
