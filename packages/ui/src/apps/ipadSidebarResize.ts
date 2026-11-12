import React from 'react';
import { isRightToLeft } from '@/lib/i18n';

export const IPAD_LEFT_SIDEBAR_WIDTH = 320;
export const IPAD_RIGHT_SIDEBAR_WIDTH = 380;
const IPAD_SIDEBAR_MIN_WIDTH = 280;
const IPAD_SIDEBAR_MAX_WIDTH = 560;
/** The workspace panel holds diffs, a file editor and a terminal, so it earns
    far more room than the sessions list ever needs. */
export const IPAD_WORKSPACE_SIDEBAR_MAX_WIDTH = 900;

/** Drag-resize for the iPad sidebars: same live-width mechanics as the desktop
    Sidebar (imperative styles during the drag, committed to state at the end),
    but with a finger-sized grab strip instead of a 3px hover handle. */
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
    // `side` is the panel's place in the layout; in RTL the layout mirrors, so the
    // start ("left") panel sits on the right and dragging left widens it.
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

/** How long an iPad side panel takes to slide in or out. */
const IPAD_PANEL_SLIDE_MS = 200;

/**
 * Opening and closing an iPad side panel. The panel's width, and with it the
 * chat's, changes once, and the panel slides over that space as a transform
 * the compositor runs: a width animation re-laid the chat out on every frame
 * and drew three or four frames per open on an iPad Air. Opening, the space
 * appears and the panel slides into it in the same frame; closing, the panel
 * slides out and the space goes once it has.
 *
 * `placed`: the panel takes its width. `inPlace`: the panel stands in it;
 * otherwise it waits off its edge, where it also stays while closed, so an
 * opening slide always has a position to start from.
 */
export function useIpadPanelSlide(open: boolean) {
  const [leaving, setLeaving] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    // Without motion the panel leaves at once: there is no slide to wait for.
    setLeaving(!open && !prefersReducedMotion());
  }
  React.useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), IPAD_PANEL_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return { placed: open || leaving, inPlace: open };
}
