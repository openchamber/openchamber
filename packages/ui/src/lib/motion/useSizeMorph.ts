import React from 'react';

import { parseCssTimeMs } from './springs';

type MorphAxis = 'width' | 'height';

const readMotionVariable = (name: string): string => (
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()
);

const prefersReducedMotion = (): boolean => (
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
);

// Height reads the layout box: a popup opens with a scale transform, and its
// scaled bounding box would make the first change start from the wrong size.
const measure = (element: HTMLElement, axis: MorphAxis): number => (
  axis === 'width' ? element.getBoundingClientRect().width : element.offsetHeight
);

/** Starts easing `element` into its new size on every change of its content; returns the cleanup. */
const watchSize = (element: HTMLElement, axis: MorphAxis): (() => void) => {
  if (typeof MutationObserver === 'undefined' || !('animate' in element)) return () => undefined;
  const morphingAttribute = `data-${axis}-morphing`;
  let settledSize = measure(element, axis);
  let laidOut = false;
  let running: { animation: Animation; from: number; to: number } | null = null;

  const start = (from: number, to: number, duration: number, currentTime: number) => {
    const animation = element.animate(
      [{ [axis]: `${from}px` }, { [axis]: `${to}px` }],
      { duration, easing: readMotionVariable('--oc-motion-layout-easing') || 'ease-out' },
    );
    animation.currentTime = currentTime;
    running = { animation, from, to };
    // While it moves, the content does not fit the box: a truncating label
    // would flash its ellipsis, a list would overflow it. The move clips
    // instead (design-system.css), until it settles.
    element.setAttribute(morphingAttribute, '');
    const settle = () => {
      if (running === null || running.animation === animation) element.removeAttribute(morphingAttribute);
    };
    animation.addEventListener('finish', settle);
    animation.addEventListener('cancel', settle);
  };

  const onContentChange = () => {
    // Until the first layout is reported, the size measured at mount is not
    // one the user saw: a popup is the full height of its list until its
    // positioner caps it, and a list that re-measured its rows in that window
    // (the model picker's first open) eased the menu down from that height.
    if (!laidOut) {
      settledSize = measure(element, axis);
      return;
    }
    const moving = running?.animation.playState === 'running' ? running : null;
    const from = moving ? measure(element, axis) : settledSize;
    const elapsed = Number(moving?.animation.currentTime ?? 0);
    running?.animation.cancel();
    running = null;
    const to = measure(element, axis);
    settledSize = to;
    const duration = parseCssTimeMs(readMotionVariable('--oc-motion-layout-duration'));
    // A change that leaves the target where it was (a virtualized list
    // mounting rows into the box as it grows) carries on with the same move
    // instead of starting it over, which stalled the growth on every row.
    if (moving && Math.abs(moving.to - to) < 1 && elapsed < duration) {
      start(moving.from, to, duration, elapsed);
      return;
    }
    // Nothing to show while hidden (zero size), when nothing moved, or for
    // readers who asked for less motion.
    if (from <= 0 || Math.abs(from - to) < 1 || prefersReducedMotion() || duration <= 0) return;
    start(from, to, duration, 0);
  };

  const observer = new MutationObserver(onContentChange);
  observer.observe(element, { childList: true, subtree: true, characterData: true });
  // The size a move starts from is the last one laid out, not the last one a
  // content change left: a popup measured as it mounts is the full height of
  // its list until its positioner caps it, and the first change after that
  // (a hovered row) eased it from that stale height down to the real one.
  const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    laidOut = true;
    if (running?.animation.playState !== 'running') settledSize = measure(element, axis);
  });
  sizes?.observe(element);
  // Without a ResizeObserver there is no first layout to wait for.
  if (!sizes) laidOut = true;
  return () => {
    observer.disconnect();
    sizes?.disconnect();
    running?.animation.cancel();
    element.removeAttribute(morphingAttribute);
  };
};

/** A stable callback that watches whichever element it was last given (null detaches); detaches on unmount. */
const useSizeMorphAttach = (axis: MorphAxis): ((element: HTMLElement | null) => void) => {
  const attachedRef = React.useRef<{ element: HTMLElement; detach: () => void } | null>(null);
  const attach = React.useCallback((element: HTMLElement | null) => {
    if (attachedRef.current?.element === element) return;
    attachedRef.current?.detach();
    attachedRef.current = element ? { element, detach: watchSize(element, axis) } : null;
  }, [axis]);
  React.useEffect(() => () => attach(null), [attach]);
  return attach;
};

const useSizeMorph = (ref: React.RefObject<HTMLElement | null>, axis: MorphAxis): void => {
  const attach = useSizeMorphAttach(axis);
  // The element can mount after the hook's owner (a picker shown only for
  // some models), so each commit checks which element the ref holds now.
  React.useLayoutEffect(() => {
    attach(ref.current);
  });
};

/**
 * Eases an element into its new width whenever its content changes, on the
 * layout spring: a picker that now names a longer model grows into it instead
 * of shoving its neighbours over in one frame. It watches the content rather
 * than a key, because a change can arrive in parts (the new name first, the
 * provider's logo a moment later); each part retargets the move from where
 * the element stands now, so it never ends short and jumps the rest. The
 * element keeps its natural width; the animation only covers the move. Width
 * is a layout property, so this runs once per change on a small inline
 * control, never on a loop.
 */
export const useWidthMorph = (ref: React.RefObject<HTMLElement | null>): void => useSizeMorph(ref, 'width');

/**
 * The same for height, on an open popup whose content changes: a filtered
 * list, an autocomplete narrowing as the user types, a menu whose items
 * arrive late. The box eases into its new height instead of jumping, and the
 * edge it is anchored to stays put: a popup above its anchor grows upward
 * (its positioner or `bottom-full` keeps the bottom edge), one below it grows
 * down.
 */
export const useHeightMorph = (ref: React.RefObject<HTMLElement | null>): void => useSizeMorph(ref, 'height');

/**
 * `useHeightMorph` as a callback ref, for a box that can mount without its
 * owner rendering (a menu popup that a portal mounts on open): the watch
 * starts when the node arrives, not at the owner's next commit.
 */
export const useHeightMorphRef = (): ((element: HTMLElement | null) => void) => useSizeMorphAttach('height');
