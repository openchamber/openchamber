import React from 'react';

import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  clampWorkspaceZoneSize,
  WORKSPACE_ZONE_MIN_SIZE,
  type AuxiliaryWorkspaceZone,
} from '@/lib/workspace/layout';

type Props = {
  zone: AuxiliaryWorkspaceZone;
  /** Current size in pixels: width for left, height for bottom. */
  size: number;
  /**
   * Largest size the zone may take, leaving the center its usable minimum.
   * Null while the container has not been measured yet.
   */
  maxSize: number | null;
  onResize: (size: number) => void;
};

const ZONE_AXIS = {
  left: 'horizontal',
  right: 'horizontal',
  bottom: 'vertical',
} as const;

// The right panel draws its own handle inside `ContextPanel`, and already has
// a label for it; this map stays complete so the zone type needs no narrowing.
const ZONE_RESIZE_LABEL = {
  left: 'workspace.zone.resize.left',
  right: 'contextPanel.actions.resizePanelAria',
  bottom: 'workspace.zone.resize.bottom',
} satisfies Record<AuxiliaryWorkspaceZone, I18nKey>;

/**
 * The draggable edge between a workspace zone and the center.
 *
 * It is a labelled `separator` with `aria-valuenow`, and the arrow keys resize
 * it in steps, so the zone can be sized without a pointer. Dragging writes
 * straight to the store; the zone is a plain flex child, so there is no ghost
 * line to keep in sync as the right panel has.
 */
export const WorkspaceResizeHandle: React.FC<Props> = ({ zone, size, maxSize, onResize }) => {
  const { t } = useI18n();
  const [isDragging, setIsDragging] = React.useState(false);
  const vertical = ZONE_AXIS[zone] === 'vertical';

  const clamp = React.useCallback((next: number) => {
    const bounded = clampWorkspaceZoneSize(zone, next);
    return maxSize === null ? bounded : Math.min(bounded, Math.max(WORKSPACE_ZONE_MIN_SIZE[zone], maxSize));
  }, [maxSize, zone]);

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setIsDragging(true);

    const start = vertical ? event.clientY : event.clientX;
    const startSize = size;

    const handleMove = (moveEvent: PointerEvent) => {
      // The left zone grows as the pointer moves right; the bottom zone grows
      // as it moves up, because its handle sits on the zone's top edge.
      const delta = vertical
        ? start - moveEvent.clientY
        : moveEvent.clientX - start;
      onResize(clamp(startSize + delta));
    };

    const handleUp = () => {
      setIsDragging(false);
      target.releasePointerCapture?.(event.pointerId);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }, [clamp, onResize, size, vertical]);

  // Held arrow keys repeat faster than React re-renders, so each step reads the
  // last size this handle asked for rather than the one it was last given.
  // Without it a held key would apply a single step and then stall.
  const sizeRef = React.useRef(size);
  React.useEffect(() => { sizeRef.current = size; }, [size]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const grow = vertical ? 'ArrowUp' : 'ArrowRight';
    const shrink = vertical ? 'ArrowDown' : 'ArrowLeft';
    if (event.key !== grow && event.key !== shrink) return;
    event.preventDefault();
    const next = clamp(sizeRef.current + (event.key === grow ? step : -step));
    sizeRef.current = next;
    onResize(next);
  }, [clamp, onResize, vertical]);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={t(ZONE_RESIZE_LABEL[zone])}
      aria-valuenow={Math.round(size)}
      aria-valuemin={WORKSPACE_ZONE_MIN_SIZE[zone]}
      aria-valuemax={maxSize === null ? undefined : Math.round(maxSize)}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative z-30 shrink-0 bg-border transition-colors',
        'focus-visible:outline-none focus-visible:bg-[var(--interactive-border)]',
        vertical ? 'h-px w-full cursor-row-resize' : 'h-full w-px cursor-col-resize',
        isDragging && 'bg-[var(--interactive-border)]',
      )}
    >
      {/* A 1px divider is the visual; this widens the grab target to 5px
          without moving anything around it. */}
      <div
        aria-hidden="true"
        className={cn(
          'absolute hover:bg-[var(--interactive-border)]/80',
          vertical ? '-top-0.5 left-0 h-[5px] w-full' : '-left-0.5 top-0 h-full w-[5px]',
        )}
      />
    </div>
  );
};
