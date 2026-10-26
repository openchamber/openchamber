import React from 'react';
import { cn } from '@/lib/utils';
import { clampPercent, resolveUsageTone } from '@/lib/quota';

interface UsageProgressBarProps {
  percent: number | null;
  tonePercent?: number | null;
  className?: string;
}

export const UsageProgressBar: React.FC<UsageProgressBarProps> = ({
  percent,
  tonePercent,
  className,
}) => {
  const clamped = clampPercent(percent) ?? 0;
  const tone = resolveUsageTone(tonePercent ?? percent);

  const fillStyle = tone === 'critical'
    ? { backgroundColor: 'var(--status-error)' }
    : tone === 'warn'
      ? { backgroundColor: 'var(--status-warning)' }
      : { backgroundColor: 'var(--status-success)' };

  return (
    <div className={cn('relative h-2.5 rounded-full bg-[var(--interactive-border)] overflow-hidden', className)}>
      <div
        className="h-full transition-all duration-300"
        style={{ ...fillStyle, width: `${clamped}%` }}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
      />
    </div>
  );
};
