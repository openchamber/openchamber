import React from 'react';
import type { LinkedMessageState } from '@/hooks/useChatTimelineScroll';
import { useChatQuoteHighlightStore } from '../hooks/chatQuoteHighlightStore';
import { loadQuoteSource as loadQuoteSourceMessage, scrollToQuoteSource as scrollToQuoteSourceMessage } from '../quoteNavigation';
import type { MessageListHandle } from '../MessageList';

/** What the quote highlight layer needs to jump to the message a quote came from. */
export const useColumnQuoteNavigation = ({
    currentSessionKey,
    currentSessionKeyRef,
    messageListRef,
    onManualNavigation,
    controllerLoadHistoryUntilMessage,
    scrollToTimelineMessage,
    checkLinkedMessage,
    handleLinkedMessageMissing,
}: {
    currentSessionKey: string | null;
    currentSessionKeyRef: React.MutableRefObject<string | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    onManualNavigation: () => void;
    controllerLoadHistoryUntilMessage: Parameters<typeof loadQuoteSourceMessage>[1]['loadHistoryUntilMessage'];
    scrollToTimelineMessage: Parameters<typeof scrollToQuoteSourceMessage>[1]['scrollToTimelineMessage'];
    checkLinkedMessage: (messageId: string) => Promise<LinkedMessageState>;
    handleLinkedMessageMissing: () => void;
}) => {
    const chatQuoteHighlights = useChatQuoteHighlightStore();
    const loadQuoteSource = React.useCallback(async (messageId: string): Promise<boolean> => {
        return loadQuoteSourceMessage(messageId, {
            currentSessionKey,
            currentSessionKeyRef,
            onManualNavigation,
            loadHistoryUntilMessage: controllerLoadHistoryUntilMessage,
            checkLinkedMessage,
            onLinkedMessageMissing: handleLinkedMessageMissing,
        });
    }, [checkLinkedMessage, controllerLoadHistoryUntilMessage, currentSessionKey, currentSessionKeyRef, handleLinkedMessageMissing, onManualNavigation]);
    const scrollToQuoteSource = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        return scrollToQuoteSourceMessage(messageId, {
            currentSessionKey,
            currentSessionKeyRef,
            scrollToTimelineMessage,
            messageListRef,
            ...options,
        });
    }, [currentSessionKey, currentSessionKeyRef, messageListRef, scrollToTimelineMessage]);
    const resolveUiPageMessageId = React.useCallback((messageId: string, partId: string) => (
        messageListRef.current?.resolveUiPageMessageId(messageId, partId) ?? messageId
    ), [messageListRef]);
    const scrollToUiPageRow = React.useCallback((messageId: string) => (
        messageListRef.current?.scrollToUiPageRow(messageId) ?? false
    ), [messageListRef]);

    return { chatQuoteHighlights, loadQuoteSource, scrollToQuoteSource, resolveUiPageMessageId, scrollToUiPageRow };
};
