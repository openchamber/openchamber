import type { WheelEvent as ReactWheelEvent } from 'react';
import { isRightToLeft } from '@/lib/i18n';

// Firefox can report wheel deltas in lines rather than pixels.
const WHEEL_LINE_PIXELS = 16;

/** Map vertical mouse wheels to horizontal scrolling, preserving native gestures and zoom. */
export const scrollTabsWithWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
  if (event.shiftKey || event.ctrlKey || event.metaKey) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
  const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_PIXELS : event.deltaY;
  // Wheel down moves toward the later tabs, which lie to the left in RTL.
  event.currentTarget.scrollLeft += isRightToLeft(event.currentTarget) ? -delta : delta;
};
