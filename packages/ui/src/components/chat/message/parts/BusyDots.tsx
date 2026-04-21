import React from 'react';
import { cn } from '@/lib/utils';

interface BusyDotsProps {
  className?: string;
}

const DOT_DELAYS_MS = [0, 200, 400] as const;

export const BusyDots: React.FC<BusyDotsProps> = ({ className }) => (
  <>
    {'\u00A0'}
    <span className={cn('inline-flex', className)} aria-hidden="true">
      {DOT_DELAYS_MS.map((delay) => (
        <span
          key={delay}
          className="animate-busy-pulse"
          style={{ animationDelay: `${delay}ms` }}
        >
          .
        </span>
      ))}
    </span>
  </>
);
