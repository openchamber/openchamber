import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import {
  useSessionActivityStartedAt,
  useSessionSettledDurationMs,
} from '@/sync/session-activity-timing';
import { formatSessionActivityDuration } from './sessionActivityDurationFormat';

/** One update per second: this readout is a clock, not an animation. */
const TICK_MS = 1000;

/**
 * Elapsed time of a session's current turn, or of the turn that just finished.
 * Colored to match the row's status marker, so the pair reads as one indicator.
 *
 * Deliberately a leaf: the tick re-renders this span alone, not the row around
 * it, so a running row costs one text update per second.
 */
export const SessionActivityDuration: React.FC<{
  sessionId: string;
  /** Turn still running (`busy` or `retry`); false renders the settled total. */
  running: boolean;
  className?: string;
}> = ({ sessionId, running, className }) => {
  const { t } = useI18n();
  const startedAt = useSessionActivityStartedAt(sessionId);
  const settledMs = useSessionSettledDurationMs(sessionId);
  const now = useDurationTickerNow(running, TICK_MS);

  const durationMs = running ? Math.max(0, now - (startedAt ?? now)) : settledMs;
  if (durationMs === undefined) return null;

  const label = formatSessionActivityDuration(durationMs, t);
  const description = running
    ? t('sessions.sidebar.session.status.activeFor', { duration: label })
    : t('sessions.sidebar.session.status.lastTurnDuration', { duration: label });

  return (
    <span
      className={cn(
        'shrink-0 tabular-nums',
        // The readout wears its dot's color, so the row reads as one signal:
        // primary while the turn runs, info once it is waiting to be read.
        running ? 'text-primary' : 'text-[var(--status-info)]',
        className,
      )}
      aria-label={description}
      title={description}
    >
      {label}
    </span>
  );
};
