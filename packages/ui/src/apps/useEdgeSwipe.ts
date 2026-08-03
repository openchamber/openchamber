import React from 'react';

/**
 * Native-feeling edge swipes on the mobile chat: start a horizontal swipe from
 * the very left/right screen edge and drag toward the centre.
 *
 * - Left edge → centre  = open the sessions drawer
 * - Right edge → centre = open the most recent overflow surface
 *
 * Only `touchstart`/`touchend` are observed (both passive), so this never
 * interferes with vertical chat scrolling or the horizontal scroll inside code
 * blocks — it just reads where the gesture began and ended. The edge zone
 * keeps it clear of in-content horizontal scroll, which lives away from the
 * screen edges.
 */

const EDGE_ZONE = 32; // px from a side where the swipe must begin
// Android reserves the physical screen edge for system navigation. Accept a
// wider start area so both OpenChamber drawers can be invoked beyond the
// system Back gesture region without changing the browser/iOS gesture.
const ANDROID_EDGE_ZONE = 80;
const MIN_DISTANCE = 64; // px of horizontal travel required to commit
const MAX_OFF_AXIS_RATIO = 0.7; // |dy| must stay below |dx| * this (keep it horizontal)

export interface EdgeSwipeOptions {
  /** Swipe that started at the left edge and travelled right. */
  onLeftEdgeSwipe?: () => void;
  /** Swipe that started at the right edge and travelled left. */
  onRightEdgeSwipe?: () => void;
}

export const useEdgeSwipe = (
  ref: React.RefObject<HTMLElement | null>,
  options: EdgeSwipeOptions,
): void => {
  // Keep callbacks in a ref so changing identities don't re-attach the listeners.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    const edgeZone = platform === 'android' ? ANDROID_EDGE_ZONE : EDGE_ZONE;

    let tracking = false;
    let fromLeftEdge = false;
    let startX = 0;
    let startY = 0;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      const width = element.clientWidth;
      const nearLeft = touch.clientX <= edgeZone;
      const nearRight = touch.clientX >= width - edgeZone;
      tracking = nearLeft || nearRight;
      fromLeftEdge = nearLeft;
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < MIN_DISTANCE) return;
      if (Math.abs(dy) > Math.abs(dx) * MAX_OFF_AXIS_RATIO) return;
      // Must travel toward the centre: left edge → rightward, right edge → leftward.
      if (fromLeftEdge && dx <= 0) return;
      if (!fromLeftEdge && dx >= 0) return;

      if (fromLeftEdge) optionsRef.current.onLeftEdgeSwipe?.();
      else optionsRef.current.onRightEdgeSwipe?.();
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
    };
  }, [ref]);
};
