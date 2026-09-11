import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { cn } from '@/lib/utils';

/**
 * Live-activity marker for one session row or aggregate: 'running' while the
 * turn streams (busy/retry), 'unread' while finished-but-unseen.
 *
 * The default is a static dot (primary while running, info while unread) —
 * the cheapest possible indicator; motion lives in the 1 Hz elapsed counter
 * (see faa9c243). The opt-in `animatedActivityIndicators` preference swaps
 * the running dot for a `loader-4` spinner stepped to 20 fps
 * (`.activity-spinner`, VS Code's steps() throttling). The explicit local
 * preference controls spinner rendering across OpenChamber runtimes.
 */
export const SessionActivityIndicator: React.FC<{
  /** 'running' (busy/retry) or 'unread' (unseen activity on a settled turn). */
  state: 'running' | 'unread';
  /** Localized accessible label; also rendered as the hover title. */
  label: string;
  className?: string;
  /** Extra classes for the running dot only (e.g. the switcher's pulse). */
  runningDotClassName?: string;
}> = ({ state, label, className, runningDotClassName }) => {
  const animated = useSessionDisplayStore((s) => s.animatedActivityIndicators);

  if (state === 'running' && animated) {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center', className)}
        aria-label={label}
        title={label}
        data-session-activity-indicator={state}
      >
        <Icon name="loader-4" className="activity-spinner h-3 w-3 text-primary" />
      </span>
    );
  }

  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        state === 'running' ? cn('bg-primary', runningDotClassName) : 'bg-[var(--status-info)]',
        className,
      )}
      aria-label={label}
      title={label}
      data-session-activity-indicator={state}
    />
  );
};
