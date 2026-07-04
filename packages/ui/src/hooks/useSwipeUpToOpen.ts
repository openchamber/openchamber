import * as React from 'react';

/**
 * Detects an upward swipe and fires `onOpen` when it clears a distance or velocity
 * threshold. Used to open the mobile recents panel by swiping up from the composer
 * footer. Non-blocking: taps and horizontal/downward drags are never claimed, so the
 * footer's own buttons keep working; only a deliberate upward swipe fires.
 *
 * Threshold-based (not finger-following) because the recents sheet animates via CSS
 * transition — the swipe decides open/no-op, the sheet handles its own slide-up.
 */

const CLAIM_THRESHOLD_PX = 8;
const OPEN_DISTANCE_PX = 40;
const FLICK_VELOCITY = 0.5; // px/ms, upward is negative

interface SwipeUpToOpenOptions {
  enabled: boolean;
  onOpen: () => void;
}

interface GestureState {
  pointerId: number;
  originEl: Element;
  startX: number;
  startY: number;
  claimed: boolean;
  lastY: number;
  lastT: number;
  velocity: number;
}

export function useSwipeUpToOpen(options: SwipeUpToOpenOptions): {
  onPointerDown: React.PointerEventHandler<HTMLDivElement>;
} {
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const gestureRef = React.useRef<GestureState | null>(null);

  const api = React.useMemo(() => {
    const teardown = (): void => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onCancel);
      }
      if (gesture?.claimed) {
        try {
          gesture.originEl.releasePointerCapture(gesture.pointerId);
        } catch {
          // Capture may already be released.
        }
      }
    };

    function onMove(event: PointerEvent): void {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;

      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;

      if (!gesture.claimed) {
        if (Math.abs(dx) < CLAIM_THRESHOLD_PX && Math.abs(dy) < CLAIM_THRESHOLD_PX) {
          return;
        }
        // Only an upward-dominant drag counts; horizontal/downward releases the pointer
        // so taps, footer scrolling, and button presses proceed untouched.
        if (dy >= 0 || Math.abs(dx) >= Math.abs(dy)) {
          teardown();
          return;
        }
        gesture.claimed = true;
        try {
          gesture.originEl.setPointerCapture(gesture.pointerId);
        } catch {
          // Non-fatal robustness aid.
        }
      }

      event.preventDefault();

      const now = performance.now();
      const dt = now - gesture.lastT;
      if (dt > 0) {
        gesture.velocity = gesture.velocity * 0.7 + ((event.clientY - gesture.lastY) / dt) * 0.3;
        gesture.lastY = event.clientY;
        gesture.lastT = now;
      }
    }

    function onEnd(event: PointerEvent): void {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (gesture.claimed) {
        const dy = event.clientY - gesture.startY;
        if (dy <= -OPEN_DISTANCE_PX || gesture.velocity < -FLICK_VELOCITY) {
          optionsRef.current.onOpen();
        }
      }
      teardown();
    }

    function onCancel(event: PointerEvent): void {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      teardown();
    }

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!optionsRef.current.enabled) return;
      if (gestureRef.current || typeof window === 'undefined') return;

      gestureRef.current = {
        pointerId: event.pointerId,
        originEl: event.currentTarget,
        startX: event.clientX,
        startY: event.clientY,
        claimed: false,
        lastY: event.clientY,
        lastT: performance.now(),
        velocity: 0,
      };

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onCancel);
    };

    return { onPointerDown, teardown };
  }, []);

  React.useEffect(() => api.teardown, [api]);

  return { onPointerDown: api.onPointerDown };
}
