import type { SearchContext } from '@/stores/useChatSearchStore';

export type ReasoningExpansionState = {
    expanded: boolean;
    source: 'auto' | 'search' | 'user';
};

export const shouldExpandReasoningForSearch = ({
    searchIsOpen,
    query,
    includeThinking,
    activeMessageId,
    activePartId,
    activePartType,
    messageId,
    partId,
}: {
    searchIsOpen: boolean;
    query: string;
    includeThinking: boolean;
    activeMessageId: string | null;
    activePartId?: string | null;
    activePartType?: 'text' | 'reasoning' | null;
    messageId: string;
    partId?: string;
}): boolean => {
    if (!searchIsOpen || !query || !includeThinking || activeMessageId !== messageId) {
        return false;
    }
    if (activePartType !== undefined && activePartType !== null && activePartType !== 'reasoning') {
        return false;
    }
    if (activePartId && partId) {
        return activePartId === partId;
    }
    return true;
};

export const getReasoningSearchContext = ({
    searchIsOpen,
    query,
    includeThinking,
    caseSensitive,
    wholeWord,
    isRegex,
    messageId,
    partId,
    partType,
}: {
    searchIsOpen: boolean;
    query: string;
    includeThinking: boolean;
    caseSensitive: boolean;
    wholeWord: boolean;
    isRegex: boolean;
    messageId: string;
    partId?: string;
    partType?: 'text' | 'reasoning';
}): SearchContext | undefined => {
    if (!searchIsOpen || !query || !includeThinking) {
        return undefined;
    }
    return {
        query,
        caseSensitive,
        wholeWord,
        isRegex,
        messageId,
        ...(partId ? { partId } : {}),
        ...(partType ? { partType } : {}),
    };
};

export const getNextReasoningExpansionForSearch = ({
    current,
    shouldExpandForSearch,
    canAutoExpand,
}: {
    current: ReasoningExpansionState;
    shouldExpandForSearch: boolean;
    canAutoExpand: boolean;
}): ReasoningExpansionState => {
    if (current.source === 'user') {
        return current;
    }
    if (shouldExpandForSearch) {
        return { expanded: true, source: 'search' };
    }
    if (current.source === 'search') {
        return { expanded: canAutoExpand, source: 'auto' };
    }
    return current;
};
