import type { StreamPhase } from '../types';

type ChatRenderMode = 'live' | 'sorted';

/**
 * Decide whether a text/reasoning part should reveal its content progressively.
 *
 * The part's own `time.end` is the authoritative per-part completion signal:
 * once a part has ended it is never treated as streaming, even if the
 * message-level phase is still `'streaming'` because the turn is busy with a
 * later tool call or pending question/permission. This stops already-complete
 * text (or reasoning) from re-typing itself while the session waits for input.
 *
 * Otherwise a part streams only during genuine `'streaming'` / `'cooldown'`
 * phases. An unknown/missing phase is never treated as streaming (do not infer
 * live activity from a weak signal).
 */
export const isPartStreaming = (
    chatRenderMode: ChatRenderMode,
    streamPhase: StreamPhase | undefined,
    hasEnded: boolean,
): boolean => {
    if (chatRenderMode !== 'live') {
        return false;
    }
    if (hasEnded) {
        return false;
    }
    return streamPhase === 'streaming' || streamPhase === 'cooldown';
};
