import type { Message, StructuredError } from '@/lib/opencode/model';

export type LastMessageState = {
  role: Message['role'];
  timestamp: number;
  hasError: boolean;
} | null;

export const readLastMessageState = (last: Message | null | undefined): LastMessageState => {
  if (!last) return null;
  if (last.role === 'assistant') {
    const completed = last.time.completed ?? 0;
    return {
      role: last.role,
      timestamp: completed > 0 ? completed : last.time.created,
      hasError: Boolean(last.error),
    };
  }
  return { role: last.role, timestamp: last.time.created, hasError: false };
};

export const findRecordedTurnError = (messages: readonly Message[] | undefined): StructuredError | null => {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' || message.role === 'assistant') return null;
    if (message.role === 'idle') return message.outcome === 'failed' ? message.error ?? null : null;
  }
  return null;
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
