import React from 'react';

import { cn } from '@/lib/utils';

export const IpadSidebarResizeHandle: React.FC<{
  side: 'left' | 'right';
  isResizing: boolean;
  ariaLabel: string;
  handleProps: React.HTMLAttributes<HTMLDivElement>;
}> = ({ side, isResizing, ariaLabel, handleProps }) => (
  <div
    // z-50 AND rendered after the panel content: panes bring their own
    // full-cover overlays at z-50 (the file editor, for one), and a handle
    // underneath them is simply not there for the finger.
    className={cn(
      'absolute inset-y-0 z-50 w-6 cursor-col-resize touch-none',
      side === 'left' ? 'right-0' : 'left-0',
    )}
    role="separator"
    aria-orientation="vertical"
    aria-label={ariaLabel}
    {...handleProps}
  >
    <div
      className={cn(
        'absolute inset-y-0 w-[3px] transition-colors',
        side === 'left' ? 'right-0' : 'left-0',
        isResizing && 'bg-[var(--interactive-border)]',
      )}
    />
  </div>
);
