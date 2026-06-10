import type { MutableRefObject } from 'react';

export type ScrollAxis = 'vertical' | 'horizontal';

export const animateElementScrollTo = (
  container: HTMLElement,
  target: number,
  axis: ScrollAxis,
  duration = 220,
  animRef?: MutableRefObject<number | null>,
  onFrame?: () => void,
  onComplete?: () => void,
): void => {
  if (animRef?.current !== null && animRef?.current !== undefined) {
    cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }

  const start = axis === 'vertical' ? container.scrollTop : container.scrollLeft;
  const change = target - start;
  const startTime = performance.now();

  const animate = (currentTime: number) => {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const t = 1 - progress;
    const ease = 1 - t * t * t;

    if (axis === 'vertical') {
      container.scrollTop = start + change * ease;
    } else {
      container.scrollLeft = start + change * ease;
    }
    onFrame?.();

    if (progress < 1) {
      const nextFrame = requestAnimationFrame(animate);
      if (animRef) {
        animRef.current = nextFrame;
      }
      return;
    }

    if (animRef) {
      animRef.current = null;
    }
    onComplete?.();
  };

  const firstFrame = requestAnimationFrame(animate);
  if (animRef) {
    animRef.current = firstFrame;
  }
};
