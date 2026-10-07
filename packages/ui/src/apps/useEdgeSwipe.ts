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
 * A swipe that starts on content still able to scroll the way the finger moves
 * (a wide table, a code block) belongs to that content, not the drawer. Once
 * that content sits at the end of that direction the drawer can still be
 * reached, but only by a long, clearly horizontal swipe, so a scroll that has
 * simply run out of room is not mistaken for intent.
 */

const EDGE_ZONE = 32; // px from a side where the swipe must begin
// Android reserves the physical screen edge for system navigation. Accept a
// wider start area so both OpenChamber drawers can be invoked beyond the
// system Back gesture region without changing the browser/iOS gesture.
const ANDROID_EDGE_ZONE = 80;
const MIN_DISTANCE = 64; // px of horizontal travel required to commit
const MAX_OFF_AXIS_RATIO = 0.7; // |dy| must stay below |dx| * this (keep it horizontal)
// A gesture that starts on content already at the end of a direction may still
// reach the drawer, but only as a deliberate swipe: longer and flatter than an
// ordinary one, so a scroll that ran out of room is not read as intent.
const STRICT_MIN_DISTANCE = 140;
const STRICT_MAX_OFF_AXIS_RATIO = 0.4;

export interface EdgeSwipeOptions {
  /** Swipe that started at the left edge and travelled right. */
  onLeftEdgeSwipe?: () => void;
  /** Swipe that started at the right edge and travelled left. */
  onRightEdgeSwipe?: () => void;
  /** Defaults to on. Flipping it re-attaches the listeners, which is what a
      drawer needs: its element only exists (or only matters) while open. */
  enabled?: boolean;
}

// Who owns a horizontal gesture that started here: the content under the finger
// while it can still scroll that way ('content'), the same content once it sits
// at the end of that direction ('content-end'), or the drawer when there is no
// horizontally scrollable content at all ('drawer'). A swipe from the left edge
// reveals content on the left, one from the right edge content on the right.
// RTL scrollers run scrollLeft from -range up to 0.
type GestureOwner = 'drawer' | 'content' | 'content-end';

const resolveGestureOwner = (target: EventTarget | null, container: HTMLElement, fromLeftEdge: boolean): GestureOwner => {
  const view = container.ownerDocument.defaultView;
  if (!view) return 'drawer';
  let contentEnd = false;
  for (let node = target instanceof view.Element ? target : null; node && node !== container; node = node.parentElement) {
    const range = node.scrollWidth - node.clientWidth;
    if (range <= 1) continue;
    const style = view.getComputedStyle(node);
    if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
    const min = style.direction === 'rtl' ? -range : 0;
    const max = min + range;
    if (fromLeftEdge ? node.scrollLeft > min + 1 : node.scrollLeft < max - 1) return 'content';
    contentEnd = true;
  }
  return contentEnd ? 'content-end' : 'drawer';
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
    let owner: GestureOwner = 'drawer';
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
      owner = (nearLeft || nearRight) ? resolveGestureOwner(event.target, element, fromLeftEdge) : 'drawer';
      tracking = (nearLeft || nearRight) && owner !== 'content';
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
      // Content sitting at its end hands the gesture to the drawer only for a
      // long, clearly horizontal swipe.
      const minDistance = owner === 'content-end' ? STRICT_MIN_DISTANCE : MIN_DISTANCE;
      const maxOffAxisRatio = owner === 'content-end' ? STRICT_MAX_OFF_AXIS_RATIO : MAX_OFF_AXIS_RATIO;
      if (Math.abs(dx) < minDistance) return;
      if (Math.abs(dy) > Math.abs(dx) * maxOffAxisRatio) return;
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
