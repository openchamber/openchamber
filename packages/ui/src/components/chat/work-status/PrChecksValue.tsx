import React from 'react';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { cn } from '@/lib/utils';
import { prChecksDotColor, type PrChecks } from './prChecks';
import { WorkStatusValue } from './WorkStatusPrimitives';

export const PrChecksValue: React.FC<{ checks: PrChecks }> = ({ checks }) => {
  const blink = useWaitingBlink(checks.pending > 0);
  return (
    <>
      <span
        aria-hidden
        data-pr-checks-dot
        className={cn('size-1.5 shrink-0 rounded-full', blink)}
        style={{ backgroundColor: prChecksDotColor(checks) }}
      />
      <WorkStatusValue>{`${checks.success}/${checks.total}`}</WorkStatusValue>
    </>
  );
};
