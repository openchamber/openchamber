
export const SESSION_TAB_EDGE_FADE_PX = 24;

type HorizontalRect = { left: number; right: number };

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
