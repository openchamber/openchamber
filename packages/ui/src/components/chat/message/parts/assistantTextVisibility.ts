import { commitStreamedText } from '../../lib/streamTextCommit';

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
