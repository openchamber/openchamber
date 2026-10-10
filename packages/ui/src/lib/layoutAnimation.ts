/**
 * Width animations of the columns beside the chat: the session sidebar and
 * the right slot (context panel and work-status card).
 *
 * While one runs, the chat column changes width on every frame and the
 * transcript re-wraps. Work that measures layout to follow a width (the
 * pinned-end scroll write, markdown table column widths, the active-turn spy)
 * would force a layout of the transcript on every one of those frames, so it
 * waits for the animation to end and runs once, at the final width.
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
export const LAYOUT_ANIMATION_MS = 120;
/** Their timing function: a plain ease-out. */
export const LAYOUT_ANIMATION_EASING = 'ease-out';

const ROOT_ATTRIBUTE = 'data-panel-animating';

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleFrame: number | null = null;
const pending = new Set<() => void>();
const startListeners = new Set<() => void>();

export const isLayoutAnimating = (): boolean => settleTimer !== null || settleFrame !== null;

/** Readers who asked for reduced motion get no width animation at all. */
const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const settle = () => {
  settleTimer = null;
  settleFrame = null;
  globalThis.document?.documentElement.removeAttribute(ROOT_ATTRIBUTE);
  const tasks = [...pending];
  pending.clear();
  for (const task of tasks) task();
};

/**
 * Marks a side-column width animation that starts now. It ends one frame after
 * `durationMs` (at once with reduced motion), when the transition has drawn
 * its last frame; a second call while one runs extends it.
 */
export const beginLayoutAnimation = (durationMs: number = LAYOUT_ANIMATION_MS): void => {
  if (!globalThis.document) return;
  const starting = !isLayoutAnimating();
  if (settleTimer !== null) clearTimeout(settleTimer);
  if (settleFrame !== null) cancelAnimationFrame(settleFrame);
  settleFrame = null;
  document.documentElement.setAttribute(ROOT_ATTRIBUTE, '');
  settleTimer = setTimeout(() => {
    settleTimer = null;
    settleFrame = requestAnimationFrame(settle);
  }, prefersReducedMotion() ? 0 : Math.max(0, durationMs));
  if (starting) startListeners.forEach((listener) => listener());
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
