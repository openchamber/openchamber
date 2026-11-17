import { commitStreamedText } from '../../lib/streamTextCommit';
import type { StreamPhase } from '../types';

// external: #3277 Part finalization releases text even while the message waits on a question or permission.
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
    return input.isStreaming
        ? commitStreamedText(input.throttledTextContent)
        : input.textContent;
};
