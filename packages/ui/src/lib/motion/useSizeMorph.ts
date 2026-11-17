import React from 'react';

import { parseCssTimeMs } from './springs';

type MorphAxis = 'width' | 'height';

const readMotionVariable = (name: string): string => (
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()
);

const prefersReducedMotion = (): boolean => (
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
);

const measure = (element: HTMLElement, axis: MorphAxis): number => (
  axis === 'width' ? element.getBoundingClientRect().width : element.offsetHeight
);

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
    element.setAttribute(morphingAttribute, '');
    const settle = () => {
      if (running === null || running.animation === animation) element.removeAttribute(morphingAttribute);
    };
    animation.addEventListener('finish', settle);
    animation.addEventListener('cancel', settle);
  };

  const onContentChange = () => {
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
    if (moving && Math.abs(moving.to - to) < 1 && elapsed < duration) {
      start(moving.from, to, duration, elapsed);
      return;
    }
    if (from <= 0 || Math.abs(from - to) < 1 || prefersReducedMotion() || duration <= 0) return;
    start(from, to, duration, 0);
  };

  const observer = new MutationObserver(onContentChange);
  observer.observe(element, { childList: true, subtree: true, characterData: true });
  const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    laidOut = true;
    if (running?.animation.playState !== 'running') settledSize = measure(element, axis);
  });
  sizes?.observe(element);
  if (!sizes) laidOut = true;
  return () => {
    observer.disconnect();
    sizes?.disconnect();
    running?.animation.cancel();
    element.removeAttribute(morphingAttribute);
  };
};

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
  React.useLayoutEffect(() => {
    attach(ref.current);
  });
};

export const useWidthMorph = (ref: React.RefObject<HTMLElement | null>): void => useSizeMorph(ref, 'width');

export const useHeightMorph = (ref: React.RefObject<HTMLElement | null>): void => useSizeMorph(ref, 'height');

export const useHeightMorphRef = (): ((element: HTMLElement | null) => void) => useSizeMorphAttach('height');
