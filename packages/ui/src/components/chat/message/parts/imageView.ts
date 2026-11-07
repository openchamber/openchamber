export type LightboxImage = { src: string; alt: string };

/** How the image sits in the window: `scale` 1 is the fitted size, `x`/`y` are the pan in pixels. */
export type ImageView = { scale: number; x: number; y: number };

export const FIT_VIEW: ImageView = { scale: 1, x: 0, y: 0 };
const MAX_SCALE = 12;

/**
 * Zooms to `nextScale` (kept between fit and `MAX_SCALE`) so the image point under
 * (`cx`, `cy`) stays under it. `origin` is where the unscaled image's top-left corner
 * sits, in the coordinates of `cx`/`cy`. Back at fit the pan is dropped.
 */
export const zoomViewAt = (view: ImageView, nextScale: number, cx: number, cy: number, origin: { left: number; top: number }): ImageView => {
    const scale = Math.min(Math.max(nextScale, 1), MAX_SCALE);
    if (scale === 1) return FIT_VIEW;
    const imageX = (cx - origin.left - view.x) / view.scale;
    const imageY = (cy - origin.top - view.y) / view.scale;
    return { scale, x: cx - origin.left - imageX * scale, y: cy - origin.top - imageY * scale };
};

