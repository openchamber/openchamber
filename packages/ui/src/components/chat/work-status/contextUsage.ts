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

type MessageTokens = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

type MessageLike = {
  id?: string;
  role?: string;
  tokens?: MessageTokens;
};

type WorkStatusContextUsage = {
  totalTokens: number;
  /** Context limit actually used for the ratio, after the default fallback. */
  limit: number;
  /** Unrounded, so the panel and the header cannot disagree by a rounding step. */
  percent: number;
};

/** The store's own fallback when a model exposes no context limit. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

const sumTokens = (tokens: MessageTokens): number => (
  (tokens.input ?? 0)
  + (tokens.output ?? 0)
  + (tokens.reasoning ?? 0)
  + (tokens.cache?.read ?? 0)
  + (tokens.cache?.write ?? 0)
);

/**
 * Usage from the newest assistant message that reported a non-zero token count.
 * Each assistant turn reports the whole window it saw, so the latest one is the
 * current fill — not a sum across turns.
 */
export const computeContextUsage = (
  messages: readonly MessageLike[],
  contextLimit: number,
): WorkStatusContextUsage | null => {
  if (messages.length === 0) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !message.tokens) continue;

    const totalTokens = sumTokens(message.tokens);
    if (totalTokens <= 0) continue;

    const limit = contextLimit > 0 ? contextLimit : DEFAULT_CONTEXT_LIMIT;
    return { totalTokens, limit, percent: (totalTokens / limit) * 100 };
  }

  return null;
};
