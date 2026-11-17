
export const ROW_DISCLOSURE_MS = 200;
export const ROW_DISCLOSURE_EASING = 'ease-out';

export const ROW_DISCLOSURE_FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }];

export const boundaryClipKeyframes = (start: number, size: number, from: number, to: number): Keyframe[] => {
  const offsets = [0, 1];
  if (to !== from) {
    for (const edge of [start, start + size]) {
      const progress = (edge - from) / (to - from);
      if (progress > 0 && progress < 1) offsets.push(progress);
    }
  }
  offsets.sort((left, right) => left - right);
  return offsets.map((offset) => {
    const boundary = from + (to - from) * offset;
    const visible = Math.min(Math.max(boundary - start, 0), size);
    return { offset, clipPath: `inset(0 0 ${size - visible}px 0)` };
  });
};

export const boundaryFadeInKeyframes = (start: number, size: number, from: number, to: number): Keyframe[] => {
  if (to === from) return [{ opacity: 1 }, { opacity: 1 }];
  const progressAt = (edge: number) => Math.min(Math.max((edge - from) / (to - from), 0), 1);
  const shown = progressAt(start);
  const solid = Math.max(progressAt(start + size / 2), shown);
  const keyframes: Keyframe[] = [{ offset: 0, opacity: 0 }];
  if (shown > 0) keyframes.push({ offset: shown, opacity: 0 });
  keyframes.push({ offset: solid, opacity: 1 });
  if (solid < 1) keyframes.push({ offset: 1, opacity: 1 });
  return keyframes;
};
