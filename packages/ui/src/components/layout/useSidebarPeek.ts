import React from 'react';

import { isRightToLeft } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { prefersReducedMotion } from '@/lib/layoutAnimation';

const PEEK_DWELL_MS = 50;
const PEEK_EDGE_PX = 18;
const PEEK_LEAVE_MS = 300;

export type SidebarPeekState = false | 'in' | 'out';

export interface SidebarPeek {
  state: SidebarPeekState;
  animationMs: number;
  overlayRef: React.RefObject<HTMLElement | null>;
  overlayHandlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onAnimationEnd: (event: React.AnimationEvent) => void;
  };
}

const POPUP_SELECTOR = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';

const isPortalledPopup = (element: Element): boolean => !document.getElementById('root')?.contains(element);

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

  React.useEffect(() => {
    if (enabled) return;
    clearTimers();
    setState(false);
  }, [clearTimers, enabled]);

  React.useEffect(() => clearTimers, [clearTimers]);

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
    // external: https://developer.mozilla.org/en-US/docs/Web/API/Element/mouseenter_event A sidebar moving under a stationary pointer needs document-exit tracking too.
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

  React.useEffect(() => {
    if (!enabled || state !== false) return;
    const cancelDwell = () => {
      if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    };
    const handlePointerMove = (event: PointerEvent) => {
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
