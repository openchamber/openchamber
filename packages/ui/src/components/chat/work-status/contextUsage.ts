/**
 * Context-window usage for a specific session.
 *
 * `useSessionUIStore.getContextUsage` cannot serve this panel. It reads
 * `getSyncMessages(sessionId)` with **no directory**, which resolves to the
 * *current* directory's child store, and it keys off the store's own
 * `currentSessionId`. A session held by another directory — a worktree, or any
 * moment right after a directory switch — therefore reads as "no messages" and
 * the readout silently disappears while the header still shows a value.
 *
 * This computes the same quantity from messages the caller has already
 * subscribed to for a known session and directory, so there is no hidden
 * global read to race with.
 */

import { findLatestContextFill, type ContextFillMessage } from '@/stores/utils/tokenUtils';

type WorkStatusContextUsage =
  | {
    state: 'measured';
    totalTokens: number;
    /** Context limit actually used for the ratio, after the default fallback. */
    limit: number;
    /** Unrounded, so the panel and the header cannot disagree by a rounding step. */
    percent: number;
  }
  /** Compacted since the last response that reported tokens: the fill is unknown, not zero. */
  | { state: 'compacted'; limit: number };

/** The store's own fallback when a model exposes no context limit. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/**
 * Usage from the newest assistant message that reported a non-zero token count,
 * or `compacted` when a finished compaction is newer than any such message
 * (see `findLatestContextFill`). The latest turn describes the current fill —
 * not a sum across turns. Within a turn, the server-reported `total` is the
 * final round-trip's window; summing the breakdown fields instead overstates
 * multi-step turns, whose input/cache fields accumulate across round-trips.
 */
export const computeContextUsage = (
  messages: readonly ContextFillMessage[],
  contextLimit: number,
): WorkStatusContextUsage | null => {
  const fill = findLatestContextFill(messages);
  if (!fill) return null;

  const limit = contextLimit > 0 ? contextLimit : DEFAULT_CONTEXT_LIMIT;
  if (fill.state === 'compacted') return { state: 'compacted', limit };

  return { state: 'measured', totalTokens: fill.totalTokens, limit, percent: (fill.totalTokens / limit) * 100 };
};
