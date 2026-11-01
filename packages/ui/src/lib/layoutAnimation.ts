/**
 * Width animations of the columns beside the chat: the session sidebar and
 * the context zones (with the work-status card), and the drags that resize
 * them.
 *
 * While one runs, the chat column changes width on every frame and the
 * transcript re-wraps. Work that measures layout to follow a width (markdown
 * table column widths, the active-turn spy) would force a layout of the
 * transcript on every one of those frames, so it waits for the animation to
 * end and runs once, at the final width. The pinned end is the exception: it
 * is held on every frame, since a reader would see it slide away.
 *
 * The flag is also published as `data-panel-animating` on the document root,
 * for profiling and probes only. No stylesheet may select on it: an attribute
 * on the root that a selector reads restyles the whole document when it flips.
 */

/**
 * Duration of both side columns' width animation, kept in sync. Components
 * read it through `useLayoutAnimationMs`, which is zero when the user turned
 * the animations off (`layoutAnimations`, Settings › General › Navigation).
 */
export const LAYOUT_ANIMATION_MS = 240;
/**
 * Their timing function, which starts slow. A column has its final width from
 * the first frame and the moving edge uncovers it; at 120 ms ease-out the
 * first frames uncovered a zone's leading column (the file tree beside the
 * editor) at once and the rest crept in after it, which read as two steps.
 */
export const LAYOUT_ANIMATION_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

const ROOT_ATTRIBUTE = 'data-panel-animating';

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleFrame: number | null = null;
let holds = 0;
let widthHolds = 0;
const pending = new Set<() => void>();
const startListeners = new Set<() => void>();
const widthDragListeners = new Set<() => void>();

export const isLayoutAnimating = (): boolean => holds > 0 || settleTimer !== null || settleFrame !== null;

/** Readers who asked for reduced motion get no width animation at all. */
export const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const settle = () => {
  settleTimer = null;
  settleFrame = null;
  if (holds > 0) return;
  globalThis.document?.documentElement.removeAttribute(ROOT_ATTRIBUTE);
  const tasks = [...pending];
  pending.clear();
  for (const task of tasks) task();
};

/**
 * Marks a side-column width animation that starts now. It ends one frame after
 * `durationMs` (at once with reduced motion) counted from the next frame, when
 * the transition begins, so it ends after the transition has drawn its last
 * frame; a second call while one runs extends it. Counted from the call, it
 * ended while the transition still ran whenever the toggle's own frame was
 * slow (40 to 60 ms), and the work waiting for the end stalled the
 * animation just short of its final width.
 */
export const beginLayoutAnimation = (durationMs: number = LAYOUT_ANIMATION_MS): void => {
  if (!globalThis.document) return;
  const starting = !isLayoutAnimating();
  if (settleTimer !== null) clearTimeout(settleTimer);
  if (settleFrame !== null) cancelAnimationFrame(settleFrame);
  settleTimer = null;
  document.documentElement.setAttribute(ROOT_ATTRIBUTE, '');
  const delay = prefersReducedMotion() ? 0 : Math.max(0, durationMs);
  settleFrame = requestAnimationFrame(() => {
    settleFrame = null;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      settleFrame = requestAnimationFrame(settle);
    }, delay);
  });
  if (starting) startListeners.forEach((listener) => listener());
};

/**
 * Marks a side column the user drags to a new size (`axis`: the chat's width,
 * or the height of the zone under it): the columns move on every pointer
 * frame just as in an animation, for as long as the drag lasts.
 * Ends one frame after the returned release, so work waiting for the end runs
 * once at the width the drag left. Without it every observer that follows a
 * width (markdown tables, the composer's controls, scroll shadows, the
 * active-turn spy) ran on each pointer frame, and the drag dropped frames in
 * proportion to what the chat and the panel showed.
 */
export const holdLayoutAnimation = (axis: 'width' | 'height' = 'width'): (() => void) => {
  if (!globalThis.document) return () => {};
  const starting = !isLayoutAnimating();
  const widthStarting = axis === 'width' && widthHolds === 0;
  holds += 1;
  if (axis === 'width') widthHolds += 1;
  document.documentElement.setAttribute(ROOT_ATTRIBUTE, '');
  if (starting) startListeners.forEach((listener) => listener());
  if (widthStarting) widthDragListeners.forEach((listener) => listener());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (axis === 'width') widthHolds -= 1;
    if (holds > 0 || settleTimer !== null || settleFrame !== null) return;
    settleFrame = requestAnimationFrame(settle);
  };
};

/**
 * Called when a drag of a column's width starts, also inside a running
 * animation (a toggle's 240 ms), where `onLayoutAnimationStart` stays quiet.
 * The drag's end is the layout settling (`runWhenLayoutSettled`).
 */
export const onWidthDragStart = (listener: () => void): (() => void) => {
  widthDragListeners.add(listener);
  return () => {
    widthDragListeners.delete(listener);
  };
};

/**
 * Called when an animation starts while none runs, before the browser lays
 * out its first frame, so a listener can note the state it starts from.
 */
export const onLayoutAnimationStart = (listener: () => void): (() => void) => {
  startListeners.add(listener);
  return () => {
    startListeners.delete(listener);
  };
};

/**
 * Runs `task` now, or once the running animation has ended. The same function
 * queued several times during one animation runs once.
 */
export const runWhenLayoutSettled = (task: () => void): void => {
  if (!isLayoutAnimating()) {
    task();
    return;
  }
  pending.add(task);
};

/** Drops a queued task, for an owner that goes away before the animation ends. */
export const cancelWhenLayoutSettled = (task: () => void): void => {
  pending.delete(task);
};
