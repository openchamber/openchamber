import type React from 'react';

/**
 * Shift+F10 opens a row's right-click menu from the keyboard, beside the
 * focused element. Windows and Linux browsers already turn it into a
 * `contextmenu` event, Mac browsers do not, and rows without a visible menu
 * button have no other keyboard way in. The key's own event is cancelled so
 * a browser that does translate it opens the menu once.
 */
export const openContextMenuFromKeyboard = (event: React.KeyboardEvent<HTMLElement>): void => {
  if (event.key !== 'F10' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target instanceof HTMLElement ? event.target : event.currentTarget;
  event.preventDefault();
  const rect = target.getBoundingClientRect();
  const rtl = getComputedStyle(target).direction === 'rtl';
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rtl ? rect.right - 8 : rect.left + 8,
    clientY: rect.bottom,
  }));
};
