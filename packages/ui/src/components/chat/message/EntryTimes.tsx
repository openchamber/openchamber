import React from 'react';
import type { Message, Part } from '@/lib/opencode/model';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { formatActivityTimestamp } from '@/lib/activityTimestampFormat';
import { readRecordedEntrySpan, spanFromPart, useSessionActivityTimestampsStore } from '@/sync/session-activity-timestamps';

export const EntryTimes: React.FC<{ message?: Message; part?: Part; running?: boolean }> = ({ message, part, running = false }) => {
  const { t, locale } = useI18n();
  const preference = useUIStore((state) => state.timeFormatPreference);
  const recorded = useSessionActivityTimestampsStore((state) => part ? readRecordedEntrySpan(state, part.sessionID, part.id) : undefined);
  let start: number | undefined;
  let end: number | undefined;
  let inProgress = running;
  if (part) {
    const span = spanFromPart(part);
    start = span.start ?? recorded?.start;
    end = span.end ?? recorded?.end;
    if (part.type === 'tool') inProgress = part.state.status === 'running' || part.state.status === 'pending';
    if (inProgress) end = undefined;
  } else if (message) {
    start = message.time.created;
    if (message.role === 'assistant' || message.role === 'shell' || message.role === 'compaction') {
      end = message.role === 'assistant' && message.closedLocally ? undefined : message.time.completed;
      inProgress = message.role === 'assistant' ? !message.time.completed : message.status === 'running';
    }
    // Atomic user/notices have a recorded creation, but no separate end time.
  }
  void locale;
  const value = (at: number | undefined, ending: boolean) => {
    if (at === undefined || !Number.isFinite(at) || at <= 0 || (ending && start !== undefined && at < start)) {
      return ending && inProgress ? t('activityTime.running') : t('activityTime.unavailable');
    }
    const formatted = formatActivityTimestamp(at, preference);
    return <time dateTime={new Date(at).toISOString()}>{formatted}</time>;
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 typography-micro text-muted-foreground tabular-nums" data-entry-times={part?.id ?? message?.id}>
    <span>{t('activityTime.start')}: {value(start, false)}</span>
    <span>{t('activityTime.end')}: {value(end, true)}</span>
  </div>;
};
