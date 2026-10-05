import React from 'react';

/**
 * Native-feeling edge swipes on the mobile shell: start a horizontal swipe from
 * the very left/right screen edge and drag toward the centre.
 *
 * On the chat that opens a drawer (left edge → sessions, right edge →
 * workspace); on an open drawer the mirrored swipe closes it (sessions drawer
 * closes from the right edge, workspace drawer from the left edge).
 *
 * Touch listeners are passive to preserve native scrolling and text selection.
 * A selection cancels the pending swipe, even if it clears before touchend.
 * A swipe that starts on content still able to scroll the way the finger
 * moves (a wide table, a code block) belongs to that content, not the drawer.
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
  /** Defaults to on. Flipping it re-attaches the listeners, which is what a
      drawer needs: its element only exists (or only matters) while open. */
  enabled?: boolean;
}

// Whether anything between `target` and `container` can still scroll
// horizontally toward the content the finger would pull into view: a swipe
// from the left edge reveals content on the left, one from the right edge
// content on the right. RTL scrollers run scrollLeft from -range up to 0.
const canScrollAlongSwipe = (target: EventTarget | null, container: HTMLElement, fromLeftEdge: boolean): boolean => {
  const view = container.ownerDocument.defaultView;
  if (!view) return false;
  for (let node = target instanceof view.Element ? target : null; node && node !== container; node = node.parentElement) {
    const range = node.scrollWidth - node.clientWidth;
    if (range <= 1) continue;
    const style = view.getComputedStyle(node);
    if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
    const min = style.direction === 'rtl' ? -range : 0;
    const max = min + range;
    if (fromLeftEdge ? node.scrollLeft > min + 1 : node.scrollLeft < max - 1) return true;
  }
  return false;
};

export const useEdgeSwipe = (
  ref: React.RefObject<HTMLElement | null>,
  options: EdgeSwipeOptions,
): void => {
  // Keep callbacks in a ref so changing identities don't re-attach the listeners.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled ?? true;

  React.useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;
    // SAFETY: Native Capacitor shells inject this bridge; both accesses are optional for web builds.
    const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    const edgeZone = platform === 'android' ? ANDROID_EDGE_ZONE : EDGE_ZONE;
    const ownerDocument = element.ownerDocument;

    let tracking = false;
    let fromLeftEdge = false;
    let startX = 0;
    let startY = 0;

    const hasSelection = () => ownerDocument.getSelection()?.isCollapsed === false;
    const cancelSwipe = () => {
      tracking = false;
    };
    const onSelectionChange = () => {
      if (tracking && hasSelection()) cancelSwipe();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || hasSelection()) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      const width = element.clientWidth;
      const nearLeft = touch.clientX <= edgeZone;
      const nearRight = touch.clientX >= width - edgeZone;
      fromLeftEdge = nearLeft;
      tracking = (nearLeft || nearRight) && !canScrollAlongSwipe(event.target, element, fromLeftEdge);
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      if (hasSelection()) return;
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
    element.addEventListener('touchcancel', cancelSwipe, { passive: true });
    element.addEventListener('selectstart', cancelSwipe);
    ownerDocument.addEventListener('selectionchange', onSelectionChange);
    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', cancelSwipe);
      element.removeEventListener('selectstart', cancelSwipe);
      ownerDocument.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [enabled, ref]);
};
