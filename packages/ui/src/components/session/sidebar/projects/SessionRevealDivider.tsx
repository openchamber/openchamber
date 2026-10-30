import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionRevealLevel } from '../sessionSidebarRowModel';

/** One revealed one-line row per this much vertical drag. */
export const SESSION_REVEAL_DRAG_STEP_PX = 34;

type SessionRevealDividerProps = {
  currentCount: number;
  minCount: number;
  maxCount: number;
  pageStep: number;
  revealLevel: SessionRevealLevel;
  onStartDrag: (event: React.PointerEvent<HTMLElement>) => void;
  onSetCount: (count: number) => void;
  /** Folds the open section back to its header; a closed section has no line. */
  onCollapse?: () => void;
};

/**
 * The faded hairline under an open project, worktree or zone whose list is
 * truncated. Dragging it down reveals rows and dragging up folds them back,
 * closing the section at its header when it reaches the top.
 *
 * The separator is the control: no labels and no grip, so a boundary between
 * two lists reads the same whether or not one of them has rows to reveal. A
 * closed section hides the line; its header opens it again.
 *
 * The drag itself lives in the list, because the line can move or disappear
 * while the pointer is still down. It is a window splitter, so the keyboard and
 * a screen reader can move it too.
 */
export const SessionRevealDivider: React.FC<SessionRevealDividerProps> = ({
  currentCount,
  minCount,
  maxCount,
  pageStep,
  revealLevel,
  onStartDrag,
  onSetCount,
  onCollapse,
}) => {
  const { t } = useI18n();
  const canExpand = currentCount < maxCount;
  const canCollapse = currentCount > 0 && Boolean(onCollapse);
  const interactive = canExpand || canCollapse;

  const clampCount = React.useCallback((value: number): number => (
    Math.min(maxCount, Math.max(minCount, Math.round(value)))
  ), [maxCount, minCount]);

  const applyCount = React.useCallback((value: number) => {
    const next = clampCount(value);
    if (next <= minCount) {
      onCollapse?.();
      onSetCount(minCount);
      return;
    }
    onSetCount(next);
  }, [clampCount, minCount, onCollapse, onSetCount]);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!interactive || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; the document listeners still end the drag.
    }
    onStartDrag(event);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!interactive) return;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = currentCount + 1;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = currentCount - 1;
        break;
      case 'PageDown':
        next = currentCount + pageStep;
        break;
      case 'PageUp':
        next = currentCount - pageStep;
        break;
      case 'Home':
        next = minCount;
        break;
      case 'End':
        next = maxCount;
        break;
      default:
        return;
    }
    event.preventDefault();
    applyCount(next);
  };

  const cursor = canExpand && canCollapse
    ? 'cursor-ns-resize'
    : canExpand
      ? 'cursor-s-resize'
      : canCollapse
        ? 'cursor-n-resize'
        : 'cursor-default';

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-valuemin={minCount}
      aria-valuemax={maxCount}
      aria-valuenow={currentCount}
      aria-label={t('sessions.sidebar.group.revealDrag')}
      tabIndex={interactive ? 0 : -1}
      data-reveal-level={revealLevel}
      className={cn(
        'oc-sidebar-reveal-divider flex h-4 w-full touch-none select-none items-center focus-visible:outline-none',
        cursor,
      )}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <span aria-hidden="true" className="oc-sidebar-reveal-line flex-1" />
    </div>
  );
};
