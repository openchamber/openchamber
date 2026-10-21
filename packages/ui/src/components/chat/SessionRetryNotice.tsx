import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { formatSessionActivityDuration } from '@/components/session/sessionActivityDurationFormat';
import { limitResetsAt } from '@/hooks/useAssistantStatus';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { useI18n } from '@/lib/i18n';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import { summarizeOpenCodeError } from '@/sync/session-error-log';
import { useSessionMessagesSelector } from '@/sync/sync-context';
import { useContinueWithModelAction } from './continueWithModelContext';
import { ContinueWithModelButton } from './components/ContinueWithModelButtons';
import { LongErrorText } from './LongErrorText';
import { readScheduledRetry, type ScheduledRetry } from './sessionErrorNoticeState';

const sameRetry = (left: ScheduledRetry | null, right: ScheduledRetry | null): boolean => (
  left === right
  || (left !== null && right !== null && left.attempt === right.attempt && left.at === right.at && left.error.message === right.error.message)
);

/**
 * A turn waiting to retry: when the next attempt runs, why the last one
 * failed, and the choice between waiting (the session keeps its model and the
 * provider's cached context) and continuing with another model.
 */
export const SessionRetryNotice: React.FC<{ sessionId: string; directory?: string }> = ({ sessionId, directory }) => {
  const retry = useSessionMessagesSelector(sessionId, directory, readScheduledRetry, sameRetry);
  const { isWorking } = useSessionActivity(sessionId, directory);
  if (!retry || !isWorking) return null;
  return <RetryNoticeBody retry={retry} />;
};

/** Its own component, so the once-a-second countdown re-renders the notice alone. */
const RetryNoticeBody: React.FC<{ retry: ScheduledRetry }> = ({ retry }) => {
  const { t } = useI18n();
  const continueWithModel = useContinueWithModelAction();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const now = useDurationTickerNow(true);
  const remaining = retry.at - now;
  const time = formatTimeForPreference(retry.at, timeFormatPreference);
  const countdown = formatSessionActivityDuration(remaining, t);
  const numbered = retry.attempt > 1;
  let title: string;
  if (remaining > 0) {
    title = numbered
      ? t('chat.retryNotice.nextNumbered', { attempt: retry.attempt, countdown, time })
      : t('chat.retryNotice.next', { countdown, time });
  } else {
    title = numbered ? t('chat.retryNotice.nowNumbered', { attempt: retry.attempt }) : t('chat.retryNotice.now');
  }
  const summary = summarizeOpenCodeError(retry.error);
  const reason = summary.message
    ? (summary.name ? `${summary.name}: ${summary.message}` : summary.message)
    : t('chat.retryNotice.noReason');
  // A rate limit that lifts after the next attempt: that attempt will most
  // likely hit it again, so the time that matters is when it lifts.
  const resetsAt = limitResetsAt(retry.error);
  const resetsLater = resetsAt !== undefined && resetsAt > retry.at;

  return (
    <div className="chat-message-column">
      <div role="status" className="mt-2 max-w-full rounded-lg bg-[var(--status-warning-background)] px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon name="time" className="size-3.5 shrink-0 text-[var(--status-warning)]" />
          <span className="typography-meta font-medium text-foreground tabular-nums">{title}</span>
        </div>
        <LongErrorText text={reason} buttonClassName="ms-[0.875rem]">
          {(visibleText) => (
            <div className="mt-1 ps-[1.375rem] typography-meta text-muted-foreground break-words">{visibleText}</div>
          )}
        </LongErrorText>
        {resetsLater ? (
          <div className="mt-1 ps-[1.375rem] typography-meta text-muted-foreground">
            {t('chat.retryNotice.limitResets', { time: formatTimeForPreference(resetsAt, timeFormatPreference) })}
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 ps-[1.375rem]">
          <span className="typography-meta text-muted-foreground">{t('chat.retryNotice.waitHint')}</span>
          {continueWithModel ? <ContinueWithModelButton onClick={continueWithModel} /> : null}
        </div>
      </div>
    </div>
  );
};
