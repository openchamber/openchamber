/** How many timeline rows are added each time the scroller reaches the end.
    The sheet is a plain scroll container (no virtualization), so a workspace
    with thousands of sessions must not mount them all at once. */
export const TIMELINE_PAGE_SIZE = 40;

/** Next reveal step, clamped to what actually exists. Returning the same count
    when nothing is left keeps the sentinel effect from looping. */
export const revealNextTimelinePage = (visibleCount: number, total: number): number =>
  Math.min(total, Math.max(visibleCount, 0) + TIMELINE_PAGE_SIZE);
