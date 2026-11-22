import type React from 'react';

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
