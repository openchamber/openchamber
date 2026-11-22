import type React from 'react';
import { swallowGestureClick } from '@/lib/swallowGestureClick';

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

let press: { timer: number; x: number; y: number } | null = null;

const cancel = (): void => {
  if (press) window.clearTimeout(press.timer);
  press = null;
};

export const longPressHandlers = (action: () => void): React.HTMLAttributes<HTMLElement> => ({
  onPointerDown: (event) => {
    cancel();
    if (event.pointerType === 'mouse') return;
    if (event.target instanceof Element && event.target.closest('button, a, input')) return;
    const timer = window.setTimeout(() => {
      press = null;
      swallowGestureClick();
      action();
    }, LONG_PRESS_MS);
    press = { timer, x: event.clientX, y: event.clientY };
  },
  onPointerMove: (event) => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE_PX) cancel();
  },
  onPointerUp: cancel,
  onPointerCancel: cancel,
  onPointerLeave: cancel,
  onContextMenu: (event) => event.preventDefault(),
});
