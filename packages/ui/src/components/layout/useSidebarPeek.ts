import React from 'react';

import { isRightToLeft } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { prefersReducedMotion } from '@/lib/layoutAnimation';

/** How long the pointer rests on the window edge before the sidebar slides out. */
const PEEK_DWELL_MS = 50;
/** How far from the window's start edge the pointer counts as on it, in px. */
const PEEK_EDGE_PX = 18;
/** How long the pointer may be away from the sidebar before it slides back. */
const PEEK_LEAVE_MS = 300;

/**
 * `in` while the collapsed sidebar is shown over the chat, `out` while it
 * slides back, `false` when it is away.
 */
export type SidebarPeekState = false | 'in' | 'out';

export interface SidebarPeek {
  state: SidebarPeekState;
  /** How long the slide takes; zero without layout animations or with reduced motion. */
  animationMs: number;
  overlayRef: React.RefObject<HTMLElement | null>;
  overlayHandlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onAnimationEnd: (event: React.AnimationEvent) => void;
  };
}

const POPUP_SELECTOR = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';

/**
 * Menus, dialogs and pickers render in portals outside the app root; the
 * same roles inside it are parts of the page that are always there (the
 * prompt navigator is a listbox).
 */
const isPortalledPopup = (element: Element): boolean => !document.getElementById('root')?.contains(element);

/**
 * A menu, dialog or picker the reader opened from the sidebar, or an inline
 * rename keeping focus in a field, holds the sidebar out until it is done.
 */
/**
 * On the start edge, below the titlebar (its drag region and window
 * controls stay as they are). Measured, not hit-tested: an element there
 * would take the clicks meant for what lies under it.
 */
const isOnStartEdge = (event: PointerEvent): boolean => {
  const fromStart = isRightToLeft(document.documentElement) ? window.innerWidth - event.clientX : event.clientX;
  if (fromStart > PEEK_EDGE_PX) return false;
  const headerHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--oc-header-height')) || 48;
  return event.clientY >= headerHeight;
};

const isHeldOpen = (overlay: HTMLElement | null): boolean => {
  const active = document.activeElement;
  if (overlay && active instanceof HTMLElement && overlay.contains(active) && (active.isContentEditable || active.matches('input, textarea'))) {
    return true;
  }
  return Array.from(document.querySelectorAll(POPUP_SELECTOR)).some((element) => isPortalledPopup(element) && element.getClientRects().length > 0);
};

/**
 * Shows the collapsed session sidebar while the mouse is on the window's
 * start edge or over the sidebar, floating over the chat without moving it.
 * Only a mouse peeks: touch and pen have no hover to leave with.
 */
export const useSidebarPeek = ({ enabled, layoutAnimationMs }: { enabled: boolean; layoutAnimationMs: number }): SidebarPeek => {
  const [state, setState] = React.useState<SidebarPeekState>(false);
  const animationMs = prefersReducedMotion() ? 0 : layoutAnimationMs;
  const animated = animationMs > 0;
  const overlayRef = React.useRef<HTMLElement | null>(null);
  const dwellTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = React.useCallback(() => {
    if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current);
    if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    dwellTimerRef.current = null;
    leaveTimerRef.current = null;
  }, []);

  const hide = React.useCallback(() => {
    clearTimers();
    setState((current) => (current === 'in' && animated ? 'out' : false));
  }, [animated, clearTimers]);

  const scheduleHide = React.useCallback(() => {
    if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = null;
      if (isHeldOpen(overlayRef.current)) {
        scheduleHide();
        return;
      }
      hide();
    }, PEEK_LEAVE_MS);
  }, [hide]);

  const cancelHide = React.useCallback(() => {
    if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = null;
  }, []);

  // Opening or collapsing the sidebar for real, or leaving the desktop
  // layout, ends a peek at once.
  React.useEffect(() => {
    if (enabled) return;
    clearTimers();
    setState(false);
  }, [clearTimers, enabled]);

  React.useEffect(() => clearTimers, [clearTimers]);

  // A click outside the sidebar and its popups, or Escape, puts it away
  // without waiting for the pointer to leave.
  React.useEffect(() => {
    if (state !== 'in') return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (overlayRef.current?.contains(target) || isPortalledPopup(target)) return;
      hide();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isIMECompositionEvent(event)) return;
      if (event.key !== 'Escape' || event.defaultPrevented || isHeldOpen(overlayRef.current)) return;
      hide();
    };
    // The sidebar slides out under a pointer resting on the edge, and the
    // browser does not hit-test for a moving element, so it gets no
    // pointerenter and no pointerleave until the pointer moves over it. A
    // pointer that goes straight off the window from there leaves only the
    // document.
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) scheduleHide();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerout', handlePointerOut);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerout', handlePointerOut);
    };
  }, [hide, scheduleHide, state]);

  // While the sidebar is away, a mouse resting on the start edge brings it.
  React.useEffect(() => {
    if (!enabled || state !== false) return;
    const cancelDwell = () => {
      if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    };
    const handlePointerMove = (event: PointerEvent) => {
      // A drag passing the edge (a file, a selection) is not a peek.
      if (event.pointerType !== 'mouse' || event.buttons !== 0 || !isOnStartEdge(event)) {
        cancelDwell();
        return;
      }
      if (dwellTimerRef.current !== null) return;
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        setState('in');
      }, PEEK_DWELL_MS);
    };
    // Off the window across the edge: no rest there.
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) cancelDwell();
    };
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerout', handlePointerOut);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerout', handlePointerOut);
      cancelDwell();
    };
  }, [enabled, state]);

  const overlayHandlers = React.useMemo<SidebarPeek['overlayHandlers']>(() => ({
    onPointerEnter: () => {
      cancelHide();
      setState((current) => (current === 'out' ? 'in' : current));
    },
    onPointerLeave: () => {
      if (state === 'in') scheduleHide();
    },
    onAnimationEnd: (event) => {
      if (event.target !== event.currentTarget) return;
      setState((current) => (current === 'out' ? false : current));
    },
  }), [cancelHide, scheduleHide, state]);

  return { state: enabled ? state : false, animationMs, overlayRef, overlayHandlers };
};
