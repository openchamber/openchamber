import React from 'react';
import { cn } from '@/lib/utils';

type SidebarSectionHeaderProps = {
  title: string;
  /** Optional right-side chrome (e.g. display-mode equalizer on Recent). */
  accessory?: React.ReactNode;
  /** First section in the scroll body — less top margin than subsequent ones. */
  isFirst?: boolean;
  /** When set, the title is a collapse control (Codex still looks like a static label). */
  onToggle?: () => void;
  expanded?: boolean;
  className?: string;
};

/**
 * Codex-style sidebar section label: muted micro title, generous top gap,
 * tight gap to the items below. Not a loud interactive row.
 */
export function SidebarSectionHeader({
  title,
  accessory,
  isFirst = false,
  onToggle,
  expanded,
  className,
}: SidebarSectionHeaderProps) {
  const titleClassName = 'typography-micro font-normal lowercase tracking-wide text-muted-foreground/80';

  return (
    <div
      className={cn(
        'group/section flex w-full items-center gap-1 px-2',
        isFirst ? 'pt-1 pb-1' : 'pt-4 pb-1',
        className,
      )}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md"
          aria-expanded={expanded}
        >
          <span className={titleClassName}>{title}</span>
        </button>
      ) : (
        <span className={cn('flex min-w-0 flex-1 items-center gap-1', titleClassName)}>
          {title}
        </span>
      )}
      {accessory ? (
        // -mr-2：equalizer 图标在 24px 命中区内居中，负 margin 把字形右缘拉齐下方 "1h"/"3h"
        <div className="ml-auto -mr-2 flex shrink-0 items-center">
          {accessory}
        </div>
      ) : null}
    </div>
  );
}
