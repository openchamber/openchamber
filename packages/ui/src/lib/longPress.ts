import type React from 'react';
import { swallowGestureClick } from '@/lib/swallowGestureClick';

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

// One finger holds one press, so one slot is enough, and a re-render of the row
// under the finger cannot lose the timer of a press still running.
let press: { timer: number; x: number; y: number } | null = null;

const cancel = (): void => {
  if (press) window.clearTimeout(press.timer);
  press = null;
};

/**
 * Pointer handlers for a touch long press on a row. A drag or a scroll cancels
 * it, and the click the lifting finger may fire is swallowed, so the row's tap
 * does not run as well.
 */
export const longPressHandlers = (action: () => void): React.HTMLAttributes<HTMLElement> => ({
  onPointerDown: (event) => {
    cancel();
    if (event.pointerType === 'mouse') return;
    // A control inside the row keeps its own press.
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
