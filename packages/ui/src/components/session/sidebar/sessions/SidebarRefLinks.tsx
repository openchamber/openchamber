import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { useOutsideRepository } from '@/components/sourceBoard/useOutsideRepository';
import { cn } from '@/lib/utils';

export const SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS = 750;

export type SidebarRefLink = {
  key: string;
  icon: IconName;
  label: string;
  status?: string | null;
  text: string;
  title: string | null;
  color?: string | null;
  url: string | null;
};

// external: https://react.dev/reference/react-dom/createPortal Portal events bubble through the React tree, so tooltip links stop row interactions.
const SidebarRefLinkHeading: React.FC<{ item: SidebarRefLink; directory: string | null }> = ({ item, directory }) => {
  const repository = useOutsideRepository(item.url, directory);
  return (
    <span className="flex min-w-0 items-center gap-1.5 group-hover/ref:underline group-disabled/ref:no-underline">
      <Icon name={item.icon} className="h-3 w-3 flex-shrink-0" />
      <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap">
        <span className="shrink-0">{item.label}</span>
        {repository ? <span className="shrink-0">·</span> : null}
        {repository ? <span className="min-w-0 truncate">{repository}</span> : null}
        {item.status ? <span className="shrink-0">· {item.status}</span> : null}
      </span>
    </span>
  );
};

export const SidebarRefLinks: React.FC<{ items: readonly SidebarRefLink[]; directory: string | null }> = ({ items, directory }) => {
  const openTrackerItem = useOpenTrackerItem();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={cn(
            'group/ref flex min-w-0 flex-col rounded text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
            !item.color && 'text-muted-foreground',
          )}
          style={item.color ? { color: item.color } : undefined}
          disabled={!item.url}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (item.url) openTrackerItem(item.url, directory, event);
          }}
        >
          <SidebarRefLinkHeading item={item} directory={directory} />
          {item.title ? (
            <span dir="auto" className="oc-ui-start-align min-w-0 truncate ps-[18px] text-muted-foreground">{item.title}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
};
