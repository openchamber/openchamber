import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { lastRunDurationMs, useSessionActivityTimestampsStore } from '@/sync/session-activity-timestamps';
import { formatSessionActivityDuration } from '../../sessionActivityDurationFormat';

/**
 * A run measured from the last prompt, for the two opt-in readouts: the live
 * count while a session works (auto-continues and background waits included,
 * since none of them is a new prompt) and the last run's length while it is
 * idle. Without a recorded prompt it renders the fallback, never a guess.
 */
export const SessionRunDuration: React.FC<{ sessionId: string; running: boolean; fallback: React.ReactNode }> = ({ sessionId, running, fallback }) => {
  const { t } = useI18n();
  const recorded = useSessionActivityTimestampsStore((state) => state.byId.get(sessionId));
  const now = useDurationTickerNow(running);
  const durationMs = running
    ? (recorded?.input === undefined ? null : Math.max(0, now - recorded.input))
    : lastRunDurationMs(recorded);
  if (durationMs === null) return <>{fallback}</>;
  const label = formatSessionActivityDuration(durationMs, t);
  const description = running
    ? t('activityTime.sinceInputFor', { duration: label })
    : t('activityTime.lastRunFor', { duration: label });
  return <span className={running ? 'shrink-0 tabular-nums text-[var(--status-info)]' : 'shrink-0 tabular-nums'} title={description} aria-label={description}>{label}</span>;
};
