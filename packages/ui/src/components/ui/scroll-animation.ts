import type { MutableRefObject } from 'react';

export type ScrollAxis = 'vertical' | 'horizontal';

const clamp01 = (value: number): number => {
  return Math.min(Math.max(value, 0), 1);
};

const getAxisMaxScroll = (container: HTMLElement, axis: ScrollAxis): number => {
  if (axis === 'vertical') {
    return Math.max(container.scrollHeight - container.clientHeight, 0);
  }
  return Math.max(container.scrollWidth - container.clientWidth, 0);
};

const getAxisScrollPosition = (container: HTMLElement, axis: ScrollAxis): number => {
  return axis === 'vertical' ? container.scrollTop : container.scrollLeft;
};

const setAxisScrollPosition = (container: HTMLElement, axis: ScrollAxis, value: number): void => {
  if (axis === 'vertical') {
    container.scrollTop = value;
    return;
  }
  container.scrollLeft = value;
};

const easeOutResponsive = (progress: number): number => {
  const clamped = clamp01(progress);
  const remaining = 1 - clamped;
  const fastStart = 1 - remaining ** 4;
  const softTail = 1 - remaining ** 1.85;
  return fastStart * (1 - clamped) + softTail * clamped;
};

const easeOutTrackRatio = (progress: number): number => {
  const clamped = clamp01(progress);
  const remaining = 1 - clamped;
  const fastTravel = 1 - remaining ** 4.8;
  const softTail = 1 - remaining ** 1.85;
  return fastTravel * (1 - clamped) + softTail * clamped;
};

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
    const ease = easeOutResponsive(progress);

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

export const animateElementScrollToRatio = (
  container: HTMLElement,
  targetRatio: number,
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

  const startMaxScroll = getAxisMaxScroll(container, axis);
  const startPosition = getAxisScrollPosition(container, axis);
  const startRatio = startMaxScroll > 0 ? startPosition / startMaxScroll : 0;
  const clampedTargetRatio = Math.min(Math.max(targetRatio, 0), 1);
  const startTime = performance.now();

  const animate = (currentTime: number) => {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const ease = easeOutTrackRatio(progress);
    const nextRatio = startRatio + (clampedTargetRatio - startRatio) * ease;
    const currentMaxScroll = getAxisMaxScroll(container, axis);
    setAxisScrollPosition(container, axis, nextRatio * currentMaxScroll);
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
