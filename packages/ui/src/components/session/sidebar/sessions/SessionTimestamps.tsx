import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { formatActivityTimestamp, SESSION_TIMESTAMP_LABELS } from '@/lib/activityTimestampFormat';
import { lastRunDurationMs, resolveSessionTimestamps, useSessionActivityTimestampsStore } from '@/sync/session-activity-timestamps';
import { formatSessionActivityDuration } from '../../sessionActivityDurationFormat';

/**
 * The session's recorded times. `placement` says where this copy sits: the
 * row shows it only in the In row mode, the hover card only in On hover.
 */
export const SessionTimestamps: React.FC<{ session: Session; placement: 'row' | 'hover' }> = ({ session, placement }) => {
  const { t, locale } = useI18n();
  const preference = useUIStore((state) => state.timeFormatPreference);
  const display = useSessionDisplayStore((state) => state.sessionTimes.display);
  const fields = useSessionDisplayStore((state) => state.sessionTimes.fields);
  const recorded = useSessionActivityTimestampsStore((state) => state.byId.get(session.id));
  if (display !== (placement === 'row' ? 'inline' : 'hover')) return null;
  const stamps = resolveSessionTimestamps(session, recorded);
  const lastRun = placement === 'hover' ? lastRunDurationMs(recorded) : null;
  void locale;
  const shown = SESSION_TIMESTAMP_LABELS.filter(([field]) => fields.includes(field));
  if (shown.length === 0 && lastRun === null) return null;
  return <dl className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 typography-micro text-muted-foreground" data-session-timestamps={session.id}>
    {shown.map(([field, label]) => {
      const value = stamps[field];
      const formatted = value === null ? t('activityTime.unavailable') : formatActivityTimestamp(value, preference);
      return <React.Fragment key={field}>
        <dt>{t(label)}</dt>
        <dd className="min-w-0 truncate text-end tabular-nums" title={formatted}>
          {value === null ? formatted : <time dateTime={new Date(value).toISOString()}>{formatted}</time>}
        </dd>
      </React.Fragment>;
    })}
    {lastRun !== null ? <>
      <dt>{t('activityTime.lastRun')}</dt>
      <dd className="text-end tabular-nums">{formatSessionActivityDuration(lastRun, t)}</dd>
    </> : null}
  </dl>;
};
