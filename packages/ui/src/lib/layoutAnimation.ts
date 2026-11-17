
export const LAYOUT_ANIMATION_MS = 240;
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

export const onWidthDragStart = (listener: () => void): (() => void) => {
  widthDragListeners.add(listener);
  return () => {
    widthDragListeners.delete(listener);
  };
};

export const onLayoutAnimationStart = (listener: () => void): (() => void) => {
  startListeners.add(listener);
  return () => {
    startListeners.delete(listener);
  };
};

export const runWhenLayoutSettled = (task: () => void): void => {
  if (!isLayoutAnimating()) {
    task();
    return;
  }
  pending.add(task);
};

export const whenLayoutSettled = (): Promise<void> => new Promise((resolve) => {
  runWhenLayoutSettled(resolve);
});

export const cancelWhenLayoutSettled = (task: () => void): void => {
  pending.delete(task);
};
