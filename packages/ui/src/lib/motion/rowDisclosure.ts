/**
 * Opening and closing a block of rows under a header in a flat list (the
 * sessions sidebar, the file trees): the rows the header shows or hides are
 * revealed above a boundary moving from the block's top to its bottom, or back,
 * and the rows after the block slide with that boundary.
 */

/** As long as a reasoning block takes to open and close in the chat. */
export const ROW_DISCLOSURE_MS = 200;
export const ROW_DISCLOSURE_EASING = 'ease-out';

/**
 * Closing rows are gone well before the boundary reaches them: kept at full
 * strength, the rows sliding up read as cutting through text that is still there.
 */
export const ROW_DISCLOSURE_FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }];

/**
 * Keyframes that show the part of a row, `size` tall at `start`, lying above a
 * boundary that moves evenly from `from` to `to`. Offsets are progress along
 * the eased timing, so the reveal keeps pace with the rows sliding below it.
 */
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

/**
 * Keyframes that fade in a row, `size` tall at `start`, as a boundary moving
 * `from` → `to` uncovers it: clear until the boundary reaches the row, solid
 * once half of it shows. Tied to the boundary, the row keeps up with the gap
 * opening for it; a fade on a clock of its own left the first rows under a
 * header empty while the rows below already slid away.
 */
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
