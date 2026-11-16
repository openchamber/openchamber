import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useSessionActivityStartedAt } from '@/sync/session-activity-timing';
import { useSessionFinishedTurnDurationMs } from '@/sync/session-turn-duration';
import { formatSessionActivityDuration } from './sessionActivityDurationFormat';


export const SessionActivityDuration: React.FC<{
  sessionId: string;
  running: boolean;
  className?: string;
}> = ({ sessionId, running, className }) => {
  const { t } = useI18n();
  const startedAt = useSessionActivityStartedAt(sessionId);
  const settledMs = useSessionFinishedTurnDurationMs(sessionId);
  const now = useDurationTickerNow(running);

  const durationMs = running ? (startedAt === undefined ? undefined : Math.max(0, now - startedAt)) : settledMs;
  if (durationMs === undefined) return null;

  const label = formatSessionActivityDuration(durationMs, t);
  const description = running
    ? t('sessions.sidebar.session.status.activeFor', { duration: label })
    : t('sessions.sidebar.session.status.lastTurnDuration', { duration: label });

  return (
    <span
      className={cn(
        'shrink-0 tabular-nums',
        running ? 'text-[var(--status-info)]' : 'text-[var(--status-success)]',
        className,
      )}
      aria-label={description}
      title={description}
    >
      {label}
    </span>
  );
};
