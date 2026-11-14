import { DEFAULT_CONTEXT_LIMIT } from '@/components/chat/work-status/contextUsage';
import { useContextWindowLimits } from '@/hooks/useContextWindowLimits';
import type { Message } from '@/lib/opencode/model';
import { findLatestContextFill } from '@/stores/utils/tokenUtils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessagesSelector } from '@/sync/sync-context';

type ContextFillReading = { state: 'measured'; totalTokens: number } | { state: 'compacted' } | null;

const selectContextFill = (messages: Message[]): ContextFillReading => {
  const fill = findLatestContextFill(messages);
  if (!fill) return null;
  return fill.state === 'measured' ? { state: 'measured', totalTokens: fill.totalTokens } : { state: 'compacted' };
};

const isSameContextFill = (a: ContextFillReading, b: ContextFillReading): boolean => {
  if (a === null || b === null) return a === b;
  if (a.state !== b.state) return false;
  return a.state === 'compacted' || (b.state === 'measured' && a.totalTokens === b.totalTokens);
};

/**
 * A named session's context fill, for a caller that is not the header — a
 * guest frame showing another directory's session, for one. A streamed step
 * replaces the message list many times while the fill stays the same, so
 * callers re-render only when a response reports a new token count or a
 * compaction finishes.
 */
export const useSessionContextReading = (sessionId: string | null, directory: string | undefined) => {
  const fill = useSessionMessagesSelector(sessionId ?? '', directory, selectContextFill, isSameContextFill);
  const { context } = useContextWindowLimits(sessionId, directory);
  const limit = context > 0 ? context : DEFAULT_CONTEXT_LIMIT;
  return { sessionId, fill, limit };
};

/**
 * The current session's context fill. See `useSessionContextReading`.
 */
export const useCurrentContextReading = () => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const directory = useSessionUIStore((state) => state.currentSessionDirectory) ?? undefined;
  return useSessionContextReading(sessionId, directory);
};
