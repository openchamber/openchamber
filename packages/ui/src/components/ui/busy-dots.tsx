import React from 'react';
import { useWaitingPhase } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';

interface BusyDotsProps {
  className?: string;
}

const PHASES = [
  [true, false, false],
  [true, true, false],
  [true, true, true],
  [false, true, true],
  [false, false, true],
] as const;

export const BusyDots: React.FC<BusyDotsProps> = ({ className }) => {
  const phase = PHASES[useWaitingPhase(true, PHASES.length)];
  return (
    <>
      {' '}
      <span data-busy-dots="" className={cn('inline-flex', className)} aria-hidden="true">
        {phase.map((shown, dot) => (
          <span key={dot} className={shown ? undefined : 'invisible'}>.</span>
        ))}
      </span>
    </>
  );
};
