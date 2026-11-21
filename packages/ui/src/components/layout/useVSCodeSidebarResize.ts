import { useCallback, useRef, useState, type PointerEvent } from 'react';
import { isRightToLeft } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

const SESSIONS_SIDEBAR_MIN_WIDTH = 196;
const SESSIONS_SIDEBAR_MAX_WIDTH = 520;
const clampWidth = (width: number) => Math.min(SESSIONS_SIDEBAR_MAX_WIDTH, Math.max(SESSIONS_SIDEBAR_MIN_WIDTH, width));

/**
 * Drag-to-resize for the expanded VS Code sessions sidebar. `handleRef` goes on
 * the resize handle: when the handle leaves the DOM mid-drag (sidebar hidden or
 * the layout collapsed), the drag ends there and saves its last preview width.
 */
export function useVSCodeSidebarResize() {
  const storedWidth = useUIStore((state) => state.sidebarWidth);
  const setStoredWidth = useUIStore((state) => state.setSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [widthDraft, setWidthDraft] = useState<number | null>(null);
  const width = clampWidth(widthDraft ?? storedWidth);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const latestWidth = useRef<number | null>(null);
  const pointerId = useRef<number | null>(null);

  const finish = useCallback(() => {
    const finalWidth = latestWidth.current;
    pointerId.current = null;
    latestWidth.current = null;
    setIsResizing(false);
    setWidthDraft(null);
    if (finalWidth !== null && finalWidth !== useUIStore.getState().sidebarWidth) {
      setStoredWidth(finalWidth);
    }
  }, [setStoredWidth]);

  const handleRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      return;
    }
    return () => {
      if (pointerId.current !== null) {
        finish();
      }
    };
  }, [finish]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // external: https://www.w3.org/TR/pointerevents/#setting-pointer-capture
      // Capture can throw when the pointer is no longer active.
    }
    pointerId.current = event.pointerId;
    startX.current = event.clientX;
    startWidth.current = width;
    latestWidth.current = width;
    setIsResizing(true);
    event.preventDefault();
  }, [width]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) {
      return;
    }
    const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
    const delta = (event.clientX - startX.current) * sign;
    const nextWidth = clampWidth(startWidth.current + delta);
    if (latestWidth.current === nextWidth) {
      return;
    }
    latestWidth.current = nextWidth;
    setWidthDraft(nextWidth);
  }, []);

  // Also wired to lostpointercapture, so an interrupted drag cannot stay active.
  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // external: https://www.w3.org/TR/pointerevents/#releasing-pointer-capture
      // Release can throw when the pointer is no longer active.
    }
    finish();
  }, [finish]);

  return { width, isResizing, handleRef, onPointerDown, onPointerMove, onPointerEnd };
}
