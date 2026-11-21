import type React from 'react';

const ROW_CONTROL_SELECTOR = 'button, a, input, textarea, [role="button"], [role="menuitem"], [role="menu"]';

export const isRowBoxClick = (event: React.MouseEvent<HTMLElement>): boolean => {
  if (event.defaultPrevented) return false;
  // SAFETY: React click targets are DOM EventTargets; closest is valid only for Elements.
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !event.currentTarget.contains(target)) return false;
  const control = target.closest(ROW_CONTROL_SELECTOR);
  return !control || !event.currentTarget.contains(control);
};
