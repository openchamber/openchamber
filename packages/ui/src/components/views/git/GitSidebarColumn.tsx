import React from 'react';
import { useI18n, isRightToLeft } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { clampGitSidebarWidth, DEFAULT_GIT_SIDEBAR_WIDTH, useUIStore } from '@/stores/useUIStore';

const MIN_DIFF_WIDTH = 360;
const MIN_SIDEBAR_WIDTH = 200;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

const fitWidth = (width: number, row: HTMLElement | null): number => {
  const clamped = clampGitSidebarWidth(width);
  const available = row?.clientWidth ?? 0;
  return available > 0 ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(clamped, available - MIN_DIFF_WIDTH)) : clamped;
};

type Drag = { pointerId: number; startX: number; startWidth: number; width: number; sign: number };

export const GitSidebarColumn: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => {
  const { t } = useI18n();
  const storedWidth = useUIStore((state) => state.gitSidebarWidth);
  const setStoredWidth = useUIStore((state) => state.setGitSidebarWidth);
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<Drag | null>(null);
  const [isResizing, setIsResizing] = React.useState(false);
  const width = clampGitSidebarWidth(storedWidth);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const column = columnRef.current;
    if (!column || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = column.getBoundingClientRect().width;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth, sign: isRightToLeft(column) ? -1 : 1 };
    setIsResizing(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const column = columnRef.current;
    if (!drag || !column || drag.pointerId !== event.pointerId) return;
    const next = fitWidth(drag.startWidth + (event.clientX - drag.startX) * drag.sign, column.parentElement);
    if (next === drag.width) return;
    drag.width = next;
    column.style.width = `${next}px`;
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsResizing(false);
    if (drag.width !== drag.startWidth) setStoredWidth(drag.width);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const column = columnRef.current;
    if (!column) return;
    if (event.key === 'Home' || event.key === 'End' || event.key === 'Enter') {
      event.preventDefault();
      const target = event.key === 'Home' ? MIN_SIDEBAR_WIDTH : event.key === 'End' ? Number.POSITIVE_INFINITY : DEFAULT_GIT_SIDEBAR_WIDTH;
      setStoredWidth(fitWidth(target, column.parentElement));
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const towardEnd = event.key === 'ArrowRight' ? 1 : -1;
    const direction = isRightToLeft(column) ? -towardEnd : towardEnd;
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    setStoredWidth(fitWidth(column.getBoundingClientRect().width + direction * step, column.parentElement));
  };

  return (
    <div
      ref={columnRef}
      className={cn('relative flex shrink-0 flex-col border-e border-edge-muted min-h-0', className)}
      style={{ width: `${width}px`, maxWidth: `calc(100% - ${MIN_DIFF_WIDTH}px)`, minWidth: MIN_SIDEBAR_WIDTH }}
    >
      {children}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t('gitView.sidebar.resizeAria')}
        aria-valuenow={width}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={clampGitSidebarWidth(Number.POSITIVE_INFINITY)}
        className={cn(
          'absolute inset-y-0 -end-[2px] z-20 w-[5px] cursor-col-resize touch-none select-none outline-none transition-colors hover:bg-[var(--interactive-border)]/80 focus-visible:bg-[var(--interactive-focus-ring)]',
          isResizing && 'bg-[var(--interactive-border)]',
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onKeyDown={handleKeyDown}
        onDoubleClick={() => setStoredWidth(DEFAULT_GIT_SIDEBAR_WIDTH)}
      />
    </div>
  );
};
