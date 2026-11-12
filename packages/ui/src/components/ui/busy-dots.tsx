import React from 'react';
import { useWaitingPhase } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';

interface BusyDotsProps {
  className?: string;
}

/**
 * Which of the three dots show in each second: they fill in one by one, then
 * empty from the first, so the row reads as scrolling round. Never all empty,
 * which would look stopped.
 */
const PHASES = [
  [true, false, false],
  [true, true, false],
  [true, true, true],
  [false, true, true],
  [false, false, true],
] as const;

/**
 * Dots after a label for as long as the model thinks or a connection is made,
 * one step a second on the shared clock. Hidden dots keep their width, so the
 * label beside them never moves.
 */
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
