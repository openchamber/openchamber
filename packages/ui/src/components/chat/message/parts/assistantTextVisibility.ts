import { commitStreamedText } from '../../lib/streamTextCommit';
import type { StreamPhase } from '../types';

// A text part sealed with `time.end` can no longer receive tokens, so the
// block-commit hold — which exists to keep a growing paragraph from mutating
// in place — has nothing left to protect for that part. Gating on part
// finalization keeps the hold for genuinely streaming parts while releasing
// sealed ones: a message blocked on a pending question (or permission ask)
// never finishes, so its pre-question text would otherwise keep its last
// line hidden until the user answers (#3277).
export const resolveAssistantTextStreaming = (input: {
    streamPhase: StreamPhase;
    isFinalized: boolean;
}): boolean => {
    if (input.isFinalized) {
        return false;
    }
    return input.streamPhase === 'streaming' || input.streamPhase === 'cooldown';
};

export const resolveAssistantDisplayText = (input: {
    textContent: string;
    throttledTextContent: string;
    isStreaming: boolean;
}): string => {
    // While streaming, reveal whole blocks only: rendering stops at the end of
    // the last finished block so a shown paragraph never mutates in place.
    // The held tail lands when its block ends (or with the finalize pass).
    return input.isStreaming
        ? commitStreamedText(input.throttledTextContent)
        : input.textContent;
};
