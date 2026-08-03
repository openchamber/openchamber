import React from 'react';

export const IPAD_LEFT_SIDEBAR_WIDTH = 320;
export const IPAD_RIGHT_SIDEBAR_WIDTH = 380;
const IPAD_SIDEBAR_MIN_WIDTH = 280;
const IPAD_SIDEBAR_MAX_WIDTH = 560;

/** Drag-resize for the iPad sidebars: same live-width mechanics as the desktop
    Sidebar (imperative styles during the drag, committed to state at the end),
    but with a finger-sized grab strip instead of a 3px hover handle. */
export function useIpadSidebarResize(side: 'left' | 'right', storageKey: string, defaultWidth: number) {
  const asideRef = React.useRef<HTMLElement | null>(null);
  const [width, setWidth] = React.useState(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
    if (!Number.isFinite(stored)) return defaultWidth;
    return Math.min(IPAD_SIDEBAR_MAX_WIDTH, Math.max(IPAD_SIDEBAR_MIN_WIDTH, stored));
  });
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIdRef = React.useRef<number | null>(null);

  const clampWidth = React.useCallback((value: number) => (
    Math.min(IPAD_SIDEBAR_MAX_WIDTH, Math.max(IPAD_SIDEBAR_MIN_WIDTH, Math.round(value)))
  ), []);

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    const aside = asideRef.current;
    if (!aside) return;
    aside.style.width = `${nextWidth}px`;
    aside.style.minWidth = `${nextWidth}px`;
    aside.style.maxWidth = `${nextWidth}px`;
    aside.style.setProperty('--oc-ipad-sidebar-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = React.useCallback((event: React.PointerEvent) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIdRef.current = event.pointerId;
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    setIsResizing(true);
    event.preventDefault();
  }, [width]);

  const handlePointerMove = React.useCallback((event: React.PointerEvent) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const delta = event.clientX - startXRef.current;
    const next = clampWidth(startWidthRef.current + (side === 'left' ? delta : -delta));
    if (liveWidthRef.current === next) return;
    liveWidthRef.current = next;
    applyLiveWidth(next);
  }, [applyLiveWidth, clampWidth, side]);

  const handlePointerEnd = React.useCallback((event: React.PointerEvent) => {
    if (pointerIdRef.current !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampWidth(liveWidthRef.current ?? startWidthRef.current);
    pointerIdRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
    try {
      window.localStorage.setItem(storageKey, String(finalWidth));
    } catch {
      // ignore
    }
  }, [clampWidth, storageKey]);

  const handleProps = React.useMemo(() => ({
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerEnd,
    onPointerCancel: handlePointerEnd,
  }), [handlePointerDown, handlePointerEnd, handlePointerMove]);

  return { asideRef, width, isResizing, handleProps };
}

