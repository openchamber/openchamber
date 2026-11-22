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

/**
 * A store message as SessionErrorNotice reads it.
 *
 * Only an assistant message finishes a turn, so only its `time.completed`
 * counts. Every other role — a prompt, or any of v2's plumbing records — is
 * timed by its creation. Reading a non-assistant record's time as a completion
 * made every fresh send look unanswered since the epoch and flashed the
 * no-reply notice whenever the server acknowledged slower than a frame.
 */
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

/**
 * When a prompt looks unanswered, the store may simply have missed the reply:
 * a live stream that drops or never delivers the turn's message events leaves
 * the prompt as the last message even though OpenCode answered it, and nothing
 * else re-reads the session until a manual reload. So the session tail is
 * re-read from the server at these offsets (ms after the prompt starts to look
 * unanswered). The notice waits for the first read to settle: a reply found by
 * it replaces the prompt as the last message and the notice never shows; a
 * failed read shows the notice, since a failure must not hide a real no-reply.
 * The later reads keep running under a visible notice so a late reply still
 * replaces it; a genuine no-reply stops costing requests after the last offset.
 */
const UNANSWERED_RECHECK_DELAYS_MS: readonly number[] = [0, 10_000, 30_000];

type RecheckScheduler = {
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
};

/**
 * Runs `refetch` once per offset in `delays` until cancelled, and calls
 * `onSettled` after each read finishes, whether it succeeded or failed. A read
 * that settles after cancellation reports nothing, so a read started for an
 * old prompt or session cannot affect the current one.
 */
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
