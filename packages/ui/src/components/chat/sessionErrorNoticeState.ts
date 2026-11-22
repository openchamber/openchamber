import type { AssistantMessage, Message } from '@/lib/opencode/model';
import { getLastConversationMessage } from '@/lib/opencode/model';
import { isStoppedTurnError } from '@/lib/messages/assistantError';

/** A retry OpenCode scheduled for a step: the attempt it will make, when, and the error that caused it. */
export type ScheduledRetry = NonNullable<AssistantMessage['retry']>;

/**
 * The retry OpenCode scheduled for `message`, while it is a step still open.
 * `session.retry.scheduled` puts it on the assistant message it will retry,
 * and the next attempt clears it; a finished step keeps none.
 */
export const scheduledRetryOf = (message: Message | undefined): ScheduledRetry | null => (
  message?.role === 'assistant' && message.time.completed === undefined ? message.retry ?? null : null
);

/** The retry OpenCode scheduled for the turn's latest step, while that step is still open. */
export const readScheduledRetry = (messages: readonly Message[] | undefined): ScheduledRetry | null => (
  scheduledRetryOf(getLastConversationMessage(messages))
);

export type LastMessageState = {
  role: Message['role'];
  timestamp: number;
  hasError: boolean;
  /** The error is a failure; a user's stop is recorded as an error too and is not one. */
  failed: boolean;
} | null;

export const readLastMessageState = (last: Message | null | undefined): LastMessageState => {
  if (!last) return null;
  if (last.role === 'assistant') {
    const completed = last.time.completed ?? 0;
    return {
      role: last.role,
      timestamp: completed > 0 ? completed : last.time.created,
      hasError: Boolean(last.error),
      failed: Boolean(last.error) && !isStoppedTurnError(last.error?.type, last.error?.message ?? ''),
    };
  }
  return { role: last.role, timestamp: last.time.created, hasError: false, failed: false };
};

const UNANSWERED_RECHECK_DELAYS_MS: readonly number[] = [0, 10_000, 30_000];

type RecheckScheduler = {
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
};

export const scheduleUnansweredRechecks = (
  refetch: () => Promise<void>,
  scheduler: RecheckScheduler,
  onSettled: () => void = () => undefined,
  delays: readonly number[] = UNANSWERED_RECHECK_DELAYS_MS,
): (() => void) => {
  let cancelled = false;
  const settle = () => {
    if (!cancelled) onSettled();
  };
  const handles = delays.map((delay) => scheduler.setTimeout(() => {
    if (cancelled) return;
    void refetch().then(settle, settle);
  }, delay));
  return () => {
    cancelled = true;
    for (const handle of handles) scheduler.clearTimeout(handle);
  };
};
