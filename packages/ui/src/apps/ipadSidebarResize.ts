import React from 'react';
import { isRightToLeft } from '@/lib/i18n';

export const IPAD_LEFT_SIDEBAR_WIDTH = 320;
export const IPAD_RIGHT_SIDEBAR_WIDTH = 380;
const IPAD_SIDEBAR_MIN_WIDTH = 280;
const IPAD_SIDEBAR_MAX_WIDTH = 560;
export const IPAD_WORKSPACE_SIDEBAR_MAX_WIDTH = 900;

export function useIpadSidebarResize(
  side: 'left' | 'right',
  storageKey: string,
  defaultWidth: number,
  maxWidth: number = IPAD_SIDEBAR_MAX_WIDTH,
) {
  const asideRef = React.useRef<HTMLElement | null>(null);
  const [width, setWidth] = React.useState(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
    if (!Number.isFinite(stored)) return defaultWidth;
    return Math.min(maxWidth, Math.max(IPAD_SIDEBAR_MIN_WIDTH, stored));
  });
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIdRef = React.useRef<number | null>(null);

  const clampWidth = React.useCallback((value: number) => (
    Math.min(maxWidth, Math.max(IPAD_SIDEBAR_MIN_WIDTH, Math.round(value)))
  ), [maxWidth]);

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
    const sign = (side === 'left' ? 1 : -1) * (isRightToLeft(event.currentTarget) ? -1 : 1);
    const next = clampWidth(startWidthRef.current + (event.clientX - startXRef.current) * sign);
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


const prefersReducedMotion = (): boolean => (
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
);

const IPAD_PANEL_SLIDE_MS = 200;

export function useIpadPanelSlide(open: boolean) {
  const [leaving, setLeaving] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setLeaving(!open && !prefersReducedMotion());
  }
  React.useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), IPAD_PANEL_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return { placed: open || leaving, inPlace: open };
}
