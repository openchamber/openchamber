/** Space the image keeps from the viewer's edges, in CSS pixels (Tailwind `p-3`). */
export const IMAGE_VIEWPORT_PADDING = 12;

const MIN_ZOOM_SCALE = 0.1;
const MAX_ZOOM_SCALE = 16;
const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
const WHEEL_LINE_PIXELS = 16;
const WHEEL_MAX_DELTA = 30;

type Size = { width: number; height: number };

/** The scale fit shows the image at: whole inside the viewer, never upscaled. */
export const fitImageScale = (natural: Size, viewport: Size): number => {
  const width = viewport.width - IMAGE_VIEWPORT_PADDING * 2;
  const height = viewport.height - IMAGE_VIEWPORT_PADDING * 2;
  if (natural.width <= 0 || natural.height <= 0 || width <= 0 || height <= 0) return 1;
  return Math.min(1, width / natural.width, height / natural.height);
};

/** Keeps a zoom inside its range; a huge image may go below the floor as far as its fit. */
export const clampImageScale = (scale: number, fitScale: number): number => (
  Math.min(MAX_ZOOM_SCALE, Math.max(Math.min(MIN_ZOOM_SCALE, fitScale), scale))
);

/** The next preset level from the current scale, the way the − and + buttons step. */
export const stepImageScale = (scale: number, direction: 1 | -1): number => {
  if (direction === 1) {
    return ZOOM_STEPS.find((step) => step > scale * 1.001) ?? MAX_ZOOM_SCALE;
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < scale * 0.999) ?? MIN_ZOOM_SCALE;
};

/**
 * Scale factor for one zoom wheel event. A trackpad pinch sends many small
 * deltas, a mouse wheel notch one large one; capping the delta keeps a notch
 * from jumping several levels at once.
 */
export const wheelZoomFactor = (deltaY: number, deltaMode: number): number => {
  const pixels = deltaMode === 1 ? deltaY * WHEEL_LINE_PIXELS : deltaY;
  const capped = Math.max(-WHEEL_MAX_DELTA, Math.min(WHEEL_MAX_DELTA, pixels));
  return Math.exp(-capped / 100);
};
