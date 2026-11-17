import React from 'react';


const EDGE_ZONE = 32;
const ANDROID_EDGE_ZONE = 80;
const MIN_DISTANCE = 64;
const MAX_OFF_AXIS_RATIO = 0.7;
const STRICT_MIN_DISTANCE = 140;
const STRICT_MAX_OFF_AXIS_RATIO = 0.4;

interface EdgeSwipeOptions {
  onLeftEdgeSwipe?: () => void;
  onRightEdgeSwipe?: () => void;
  enabled?: boolean;
}

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
      const minDistance = owner === 'content-end' ? STRICT_MIN_DISTANCE : MIN_DISTANCE;
      const maxOffAxisRatio = owner === 'content-end' ? STRICT_MAX_OFF_AXIS_RATIO : MAX_OFF_AXIS_RATIO;
      if (Math.abs(dx) < minDistance) return;
      if (Math.abs(dy) > Math.abs(dx) * maxOffAxisRatio) return;
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
