import React from 'react';

import { useSpinnerPhase } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';

const BAR_COUNT = 8;
/** Opacity of each bar by its distance behind the lit one. */
const TAIL_OPACITY = [1, 0.82, 0.66, 0.52, 0.4, 0.32, 0.26, 0.22];
/** One rounded bar at twelve o'clock, 2.2 wide and 6 tall. */
const BAR_PATH = 'M12 2a1.1 1.1 0 0 1 1.1 1.1v3.8a1.1 1.1 0 0 1-2.2 0V3.1A1.1 1.1 0 0 1 12 2z';

/**
 * The app's loading spinner: eight bars around a circle, the lit one moving
 * one bar forward four times a second on the shared clock
 * (`hooks/useDurationTicker.ts`). Every spinner on screen steps in the same
 * frame, so any number of them draws four frames a second. A CSS spinner draws
 * sixty and keeps the compositor busy for as long as it shows. Size and color
 * come from `className`, like an `Icon`.
 */
export const Spinner: React.FC<{ className?: string; 'aria-label'?: string; 'aria-hidden'?: boolean | 'true' | 'false' }> = ({ className, ...aria }) => {
  const lit = useSpinnerPhase(true, BAR_COUNT);
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4 shrink-0', className)} data-spinner="" role={aria['aria-label'] ? 'img' : undefined} {...aria}>
      {TAIL_OPACITY.map((_, bar) => (
        // A path: inside buttons the WebKit fixes in index.css unfill every
        // rect and circle but keep paths in currentColor.
        <path
          key={bar}
          d={BAR_PATH}
          fill="currentColor"
          opacity={TAIL_OPACITY[(lit - bar + BAR_COUNT) % BAR_COUNT]}
          transform={`rotate(${bar * (360 / BAR_COUNT)} 12 12)`}
        />
      ))}
    </svg>
  );
};
