import React from 'react';
import { cn } from '@/lib/utils';
import { clampPercent, resolveUsageTone } from '@/lib/quota';

interface UsageProgressBarProps {
  percent: number | null;
  tonePercent?: number | null;
  className?: string;
  /** 
   * Position (0-100) to show a marker indicating expected usage based on time elapsed.
   * Used for weekly/monthly quotas to show where usage "should" be if evenly distributed.
   */
  expectedMarkerPercent?: number | null;
}

export const UsageProgressBar: React.FC<UsageProgressBarProps> = ({
  percent,
  tonePercent,
  className,
  expectedMarkerPercent,
}) => {
  const clamped = clampPercent(percent) ?? 0;
  const tone = resolveUsageTone(tonePercent ?? percent);
  const markerClamped = expectedMarkerPercent != null
    ? Math.max(0, Math.min(100, expectedMarkerPercent))
    : null;

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
      {markerClamped != null && markerClamped > 0 && markerClamped < 100 && (
        <div
          className="absolute top-0 h-full w-0.5 bg-foreground"
          style={{ left: `${markerClamped}%` }}
          title={`Expected usage if spread evenly: ${Math.round(markerClamped)}% of quota`}
          aria-hidden="true"
        />
      )}
    </div>
  );
};
