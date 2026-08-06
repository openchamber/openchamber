import React from 'react';
import { RiArrowDownSLine } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type MobileSessionChildToggleProps = {
  expanded: boolean;
  onToggle: () => void;
  /** Left position in px for the absolute gutter slot */
  left: number;
};

/**
 * Subsession expand/collapse control for mobile session rows. Lives in the
 * left gutter, completely separate from the row's status area. The child
 * toggle stays available regardless of live-status presentation.
 */
export function MobileSessionChildToggle({
  expanded,
  onToggle,
  left,
}: MobileSessionChildToggleProps): React.ReactElement {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="absolute z-10 flex w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      style={{ left, top: 0, bottom: 0, touchAction: 'manipulation' }}
      aria-label={expanded
        ? t('sessions.sidebar.session.subsessions.collapse')
        : t('sessions.sidebar.session.subsessions.expand')}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <RiArrowDownSLine className={cn('size-[18px] transition-transform duration-150', expanded ? 'rotate-0' : '-rotate-90')} />
    </button>
  );
}