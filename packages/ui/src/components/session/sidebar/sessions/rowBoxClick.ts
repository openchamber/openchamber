import type React from 'react';

// The row's own controls handle their clicks: its main button, chevrons,
// marks, the action buttons and the menus portalled from it.
const ROW_CONTROL_SELECTOR = 'button, a, input, textarea, [role="button"], [role="menuitem"], [role="menu"]';

/**
 * Whether a click on a sidebar row's box landed outside the row's own
 * controls: on its paddings, its gutter, the second line of a detailed row.
 * The highlight covers the whole box, so every point of it opens the row.
 * A click in a popup the row portals (its tooltip, which can hold a space's
 * state and actions) bubbles here through React, but lies outside the box.
 * Only controls inside the box count: the row sits in wrappers that carry a
 * button role themselves (the drag handle around a session row).
 */
export const isRowBoxClick = (event: React.MouseEvent<HTMLElement>): boolean => {
  if (event.defaultPrevented) return false;
  // SAFETY: React click targets are DOM EventTargets; closest is valid only for Elements.
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !event.currentTarget.contains(target)) return false;
  const control = target.closest(ROW_CONTROL_SELECTOR);
  return !control || !event.currentTarget.contains(control);
};
