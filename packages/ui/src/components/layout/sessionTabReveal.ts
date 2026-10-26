/**
 * Keeping the active session tab clear of the strip's edge fades.
 *
 * The header tab scroller fades its last pixels at each end to hint at tabs
 * that sit past the edge. A tab aligned flush with an edge puts that fade over
 * its own hover controls, the session menu and the close button, so the tab
 * looks like it has no way to be closed. The reveal therefore stops short of
 * each edge by the fade's width.
 */

/** How much of each end of the scroller the edge fades cover. */
export const SESSION_TAB_EDGE_FADE_PX = 24;

type HorizontalRect = { left: number; right: number };

/**
 * The distance to add to the scroller's `scrollLeft` to bring `tab` fully into
 * view with `inset` pixels to spare at both ends, or 0 when it already fits.
 *
 * The rects are physical, so the result works in either direction: a positive
 * value moves the scroller's viewport to the right and a negative one to the
 * left, whichever way the interface faces. When the tab is wider than the space
 * between the two insets, the end edge wins and the start edge may stay clipped.
 */
export const sessionTabRevealDelta = (
  viewport: HorizontalRect,
  tab: HorizontalRect,
  inset: number = SESSION_TAB_EDGE_FADE_PX,
): number => {
  const pastEnd = tab.right - (viewport.right - inset);
  if (pastEnd > 0) {
    return pastEnd;
  }
  const beforeStart = tab.left - (viewport.left + inset);
  return beforeStart < 0 ? beforeStart : 0;
};
