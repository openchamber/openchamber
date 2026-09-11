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
    chatRenderMode: 'sorted' | 'live';
    isFinalized: boolean;
}): boolean => {
    if (input.isFinalized) {
        return false;
    }
    return input.chatRenderMode === 'live'
        && (input.streamPhase === 'streaming' || input.streamPhase === 'cooldown');
};

export const resolveAssistantDisplayText = (input: {
    textContent: string;
    throttledTextContent: string;
    isStreaming: boolean;
}): string => {
    // While streaming, reveal whole blocks only: rendering stops at the last
    // complete line so a shown paragraph never mutates in place. The held
    // tail lands with the next line break (or the finalize pass).
    return input.isStreaming
        ? commitStreamedText(input.throttledTextContent)
        : input.textContent;
};

export const shouldRenderAssistantText = (input: {
    displayTextContent: string;
    isFinalized: boolean;
}): boolean => {
    if (!input.isFinalized && input.displayTextContent.trim().length === 0) {
        return false;
    }
    return input.displayTextContent.trim().length > 0;
};
