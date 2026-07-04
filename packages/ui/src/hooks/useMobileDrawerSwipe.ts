import * as React from 'react';
import { animate, type MotionValue } from 'motion/react';

/**
 * Touch/pointer swipe gesture for the mobile left session drawer.
 *
 * Drives the EXISTING `leftDrawerX` motion value in MainLayout — it does not own
 * the drawer, its visibility, or its resting animation. Two entry points:
 *
 * - `onEdgePointerDown`: attach to an invisible strip on the left screen edge.
 *   A rightward, horizontal-dominant drag opens the (closed) drawer, finger-following.
 * - `onDrawerPointerDown`: attach to the open drawer overlay. A leftward,
 *   horizontal-dominant drag closes it, finger-following.
 *
 * On release the drawer settles open/closed by position threshold (past 40% of its
 * width) or a velocity flick. Vertical-dominant gestures are abandoned immediately so
 * native scrolling (chat list, session list) is never hijacked. All per-move work runs
 * through the motion value with zero React re-renders.
 */

const CLAIM_THRESHOLD_PX = 8;
// Open when the drawer is revealed past 40% (x > -width * 0.6).
const OPEN_POSITION_RATIO = 0.6;
// px/ms flick that decides direction regardless of how far the drawer travelled.
const FLICK_VELOCITY = 0.5;
// Mirrors the spring used by MainLayout's own drawer animations.
const SPRING = { type: 'spring', stiffness: 400, damping: 35, mass: 0.8 } as const;

type SwipeSource = 'edge' | 'drawer';

interface GestureState {
  pointerId: number;
  source: SwipeSource;
  originEl: Element;
  startClientX: number;
  startClientY: number;
  startValue: number;
  claimed: boolean;
  lastX: number;
  lastT: number;
  velocity: number;
}

export interface MobileDrawerSwipeOptions {
  isMobile: boolean;
  isSettingsDialogOpen: boolean;
  /** The right drawer being open suppresses the left-drawer gesture. */
  rightDrawerOpen: boolean;
  drawerOpen: boolean;
  drawerX: MotionValue<number>;
  drawerWidthRef: React.MutableRefObject<number>;
  setDrawerOpen: (open: boolean) => void;
}

export interface MobileDrawerSwipeHandlers {
  onEdgePointerDown: React.PointerEventHandler<HTMLDivElement>;
  onDrawerPointerDown: React.PointerEventHandler<HTMLDivElement>;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function useMobileDrawerSwipe(
  options: MobileDrawerSwipeOptions,
): MobileDrawerSwipeHandlers {
  // Latest options, read synchronously at gesture time so release logic sees the
  // current open state without re-creating the (stable) handlers.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const gestureRef = React.useRef<GestureState | null>(null);

  const api = React.useMemo(() => {
    const resolveWidth = (): number => {
      const width = optionsRef.current.drawerWidthRef.current;
      if (width && width > 0) {
        return width;
      }
      return typeof window === 'undefined' ? 0 : window.innerWidth;
    };

    const teardown = (): void => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointermove', onWindowMove);
        window.removeEventListener('pointerup', onWindowEnd);
        window.removeEventListener('pointercancel', onWindowCancel);
      }
      if (gesture?.claimed) {
        try {
          gesture.originEl.releasePointerCapture(gesture.pointerId);
        } catch {
          // Capture may already be released.
        }
      }
    };

    const settle = (target: boolean): void => {
      const { drawerOpen, setDrawerOpen, drawerX } = optionsRef.current;
      const width = resolveWidth();
      if (target !== drawerOpen) {
        // State change: MainLayout's effect springs the motion value to rest.
        setDrawerOpen(target);
      } else {
        // Unchanged state: the effect won't fire, so snap back here.
        animate(drawerX, target ? 0 : -width, SPRING);
      }
    };

    function onWindowMove(event: PointerEvent): void {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }

      const dx = event.clientX - gesture.startClientX;
      const dy = event.clientY - gesture.startClientY;

      if (!gesture.claimed) {
        if (Math.abs(dx) < CLAIM_THRESHOLD_PX && Math.abs(dy) < CLAIM_THRESHOLD_PX) {
          return;
        }
        // Vertical-dominant → let native scrolling take over.
        if (Math.abs(dy) >= Math.abs(dx)) {
          teardown();
          return;
        }
        // Wrong horizontal direction for this source → abandon (edge opens on
        // rightward drags, the open drawer closes on leftward drags).
        const rightward = dx > 0;
        if (
          (gesture.source === 'edge' && !rightward) ||
          (gesture.source === 'drawer' && rightward)
        ) {
          teardown();
          return;
        }
        gesture.claimed = true;
        optionsRef.current.drawerX.stop();
        try {
          gesture.originEl.setPointerCapture(gesture.pointerId);
        } catch {
          // Non-fatal: capture is a best-effort robustness aid.
        }
      }

      // Only claim horizontal movement once we own the gesture.
      event.preventDefault();

      const now = performance.now();
      const dt = now - gesture.lastT;
      if (dt > 0) {
        const instant = (event.clientX - gesture.lastX) / dt;
        gesture.velocity = gesture.velocity * 0.7 + instant * 0.3;
        gesture.lastX = event.clientX;
        gesture.lastT = now;
      }

      const width = resolveWidth();
      optionsRef.current.drawerX.set(clamp(gesture.startValue + dx, -width, 0));
    }

    function onWindowEnd(event: PointerEvent): void {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      if (gesture.claimed) {
        const width = resolveWidth();
        const x = optionsRef.current.drawerX.get();
        let target: boolean;
        if (gesture.velocity > FLICK_VELOCITY) {
          target = true;
        } else if (gesture.velocity < -FLICK_VELOCITY) {
          target = false;
        } else {
          target = x > -width * OPEN_POSITION_RATIO;
        }
        settle(target);
      }
      teardown();
    }

    function onWindowCancel(event: PointerEvent): void {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      if (gesture.claimed) {
        // Return to whichever resting state we started from.
        settle(optionsRef.current.drawerOpen);
      }
      teardown();
    }

    const begin = (event: React.PointerEvent<HTMLDivElement>, source: SwipeSource): void => {
      const opts = optionsRef.current;
      if (!opts.isMobile || opts.isSettingsDialogOpen || opts.rightDrawerOpen) {
        return;
      }
      if (source === 'edge' && opts.drawerOpen) {
        return;
      }
      if (source === 'drawer' && !opts.drawerOpen) {
        return;
      }
      // Ignore secondary pointers while a gesture is active.
      if (gestureRef.current || typeof window === 'undefined') {
        return;
      }

      gestureRef.current = {
        pointerId: event.pointerId,
        source,
        originEl: event.currentTarget,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startValue: opts.drawerX.get(),
        claimed: false,
        lastX: event.clientX,
        lastT: performance.now(),
        velocity: 0,
      };

      // Track on window: the pointer leaves the 24px edge strip almost immediately.
      // Non-passive so we can preventDefault once the horizontal gesture is claimed.
      window.addEventListener('pointermove', onWindowMove, { passive: false });
      window.addEventListener('pointerup', onWindowEnd);
      window.addEventListener('pointercancel', onWindowCancel);
    };

    return {
      onEdgePointerDown: (event: React.PointerEvent<HTMLDivElement>) => begin(event, 'edge'),
      onDrawerPointerDown: (event: React.PointerEvent<HTMLDivElement>) => begin(event, 'drawer'),
      teardown,
    };
  }, []);

  // Drop any in-flight gesture + listeners if the host unmounts mid-drag.
  React.useEffect(() => api.teardown, [api]);

  return {
    onEdgePointerDown: api.onEdgePointerDown,
    onDrawerPointerDown: api.onDrawerPointerDown,
  };
}
