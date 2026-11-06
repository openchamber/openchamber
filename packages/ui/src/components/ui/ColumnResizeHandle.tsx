import React from 'react';

import { isRightToLeft } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const MIN_COLUMN_PX = 40;

/**
 * The grip on a table heading's end edge. Dragging reports the width while it
 * moves and once at the end; a double click hands the column back to its
 * automatic width.
 */
export const ColumnResizeHandle: React.FC<{
  label: string;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onReset: () => void;
}> = ({ label, onResize, onResizeEnd, onReset }) => {
  const drag = React.useRef<{ startX: number; startWidth: number; sign: number; width: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    const cell = event.currentTarget.closest('th, td');
    if (!cell || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = cell.getBoundingClientRect().width;
    drag.current = { startX: event.clientX, startWidth, width: startWidth, sign: isRightToLeft(cell) ? -1 : 1 };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    if (!state) return;
    state.width = Math.max(MIN_COLUMN_PX, Math.round(state.startWidth + (event.clientX - state.startX) * state.sign));
    onResize(state.width);
  };

  const onPointerUp = () => {
    if (drag.current) onResizeEnd(drag.current.width);
    drag.current = null;
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className={cn(
        'absolute inset-y-0 end-0 z-10 w-2 cursor-col-resize touch-none select-none pointer-coarse:w-5',
        'after:absolute after:inset-y-0 after:end-0 after:w-px after:bg-transparent hover:after:bg-[var(--primary-base)]',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onReset();
      }}
    />
  );
};
