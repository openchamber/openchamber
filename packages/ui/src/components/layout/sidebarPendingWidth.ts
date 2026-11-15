/**
 * How much wider the session sidebar is on screen than the width it was told
 * to take: positive while it folds, negative while it unfolds, zero once it
 * has arrived (and where there is no sidebar).
 *
 * Everything beside the sidebar gets that much room once its animation ends.
 * A width measured mid-animation plus this is the width the layout settles
 * at, so a decision made from it holds for the whole animation instead of
 * flipping when the measured width crosses a threshold halfway through.
 */
export const sidebarPendingWidth = (): number => {
  const sidebar = document.querySelector<HTMLElement>('[data-left-sidebar]');
  if (!sidebar) return 0;
  return Math.round(sidebar.getBoundingClientRect().width - (Number.parseFloat(sidebar.style.width) || 0));
};
