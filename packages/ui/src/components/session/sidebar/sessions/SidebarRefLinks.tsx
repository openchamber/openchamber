import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';

/** Sidebar tooltips that list PRs or issues linger this long after the pointer
    leaves, so it can travel into them and open a link. */
export const SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS = 750;

/** One PR or issue a sidebar tooltip lists. */
export type SidebarRefLink = {
  key: string;
  icon: IconName;
  /** Number or identifier with its state, e.g. `#12 · Open`. */
  text: string;
  title: string | null;
  /** Theme PR colour; absent shows it muted (state unknown). */
  color?: string | null;
  url: string | null;
};

// The tooltip is portaled, but React events still bubble through the row or
// header that owns it: each link keeps its pointer and clicks to itself, so
// opening it never selects, toggles or drags what sits underneath.
export const SidebarRefLinks: React.FC<{ items: readonly SidebarRefLink[] }> = ({ items }) => (
  <div className="flex min-w-0 flex-col gap-1">
    {items.map((item) => (
      <button
        key={item.key}
        type="button"
        className={cn(
          'group/ref flex min-w-0 flex-col rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
          !item.color && 'text-muted-foreground',
        )}
        style={item.color ? { color: item.color } : undefined}
        disabled={!item.url}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (item.url) void openExternalUrl(item.url);
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5 group-hover/ref:underline group-disabled/ref:no-underline">
          <Icon name={item.icon} className="h-3 w-3 flex-shrink-0" />
          <span className="min-w-0 truncate">{item.text}</span>
        </span>
        {item.title ? (
          <span className="min-w-0 truncate pl-[18px] text-muted-foreground">{item.title}</span>
        ) : null}
      </button>
    ))}
  </div>
);
