const ENTRY_VIRTUALIZE_THRESHOLD = 5;
const HEAVY_ENTRY_MESSAGE_THRESHOLD = 12;
const DESKTOP_OVERSCAN = 8;
const MOBILE_OVERSCAN = 16;

export const DEFAULT_HISTORY_MESSAGE_SIZE = 320;

interface HistoryWindowingInput {
    entryCount: number;
    maxEntryMessageCount: number;
    isMobile: boolean;
}

export interface HistoryWindowing {
    shouldVirtualize: boolean;
    overscan: number;
}

export const resolveHistoryWindowing = ({
    entryCount,
    maxEntryMessageCount,
    isMobile,
}: HistoryWindowingInput): HistoryWindowing => {
    const hasHeavyEntry = maxEntryMessageCount >= HEAVY_ENTRY_MESSAGE_THRESHOLD;
    return {
        shouldVirtualize: isMobile || entryCount >= ENTRY_VIRTUALIZE_THRESHOLD || hasHeavyEntry,
        overscan: hasHeavyEntry ? 0 : (isMobile ? MOBILE_OVERSCAN : DESKTOP_OVERSCAN),
    };
};

export const estimateHistoryEntrySize = (
    messageCount: number,
    estimatedMessageSize = DEFAULT_HISTORY_MESSAGE_SIZE,
): number => Math.max(
    DEFAULT_HISTORY_MESSAGE_SIZE,
    Math.max(1, messageCount) * estimatedMessageSize,
);
