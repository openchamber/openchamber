import React from 'react';

import { useSpinnerPhase } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';

const BAR_COUNT = 8;
const TAIL_OPACITY = [1, 0.82, 0.66, 0.52, 0.4, 0.32, 0.26, 0.22];
const BAR_PATH = 'M12 2a1.1 1.1 0 0 1 1.1 1.1v3.8a1.1 1.1 0 0 1-2.2 0V3.1A1.1 1.1 0 0 1 12 2z';

export const Spinner: React.FC<{ className?: string; 'aria-label'?: string; 'aria-hidden'?: boolean | 'true' | 'false' }> = ({ className, ...aria }) => {
  const lit = useSpinnerPhase(true, BAR_COUNT);
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4 shrink-0', className)} data-spinner="" role={aria['aria-label'] ? 'img' : undefined} {...aria}>
      {TAIL_OPACITY.map((_, bar) => (
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
