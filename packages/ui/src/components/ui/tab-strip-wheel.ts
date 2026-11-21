import type { WheelEvent as ReactWheelEvent } from 'react';
import { isRightToLeft } from '@/lib/i18n';

// external: https://developer.mozilla.org/en-US/docs/Web/API/WheelEvent/deltaMode Firefox wheel deltas can use line units.
const WHEEL_LINE_PIXELS = 16;

export const scrollTabsWithWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
  if (event.shiftKey || event.ctrlKey || event.metaKey) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
  const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_PIXELS : event.deltaY;
  event.currentTarget.scrollLeft += isRightToLeft(event.currentTarget) ? -delta : delta;
};
