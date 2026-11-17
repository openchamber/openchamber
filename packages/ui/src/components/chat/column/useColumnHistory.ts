import React from 'react';
import type { Message, Part } from '@/lib/opencode/model';
import { keepCommandSubagentReports } from '@/lib/opencode/subagent-run';
import { dropReplyCommandRows } from '@/lib/opencode/reply-command';
import { useSessionStartTimes, useSessionMessageLoader } from '@/sync/sync-context';
import { useChatTimelineController } from '../hooks/useChatTimelineController';
import type { MessageListHandle } from '../MessageList';

const HISTORY_TRIM_DELAY_MS = 3000;

type TimelineControllerArgs = Parameters<typeof useChatTimelineController>[0];

export const useColumnHistory = ({
    active,
    currentSessionId,
    currentSessionKey,
    effectiveSessionDirectory,
    messageLoader,
    sessionMessages,
    historyMeta,
    sessionIsWorking,
    scrollRef,
    scrollNode,
    messageListRef,
    loadMoreMessages,
    goToBottom,
    onManualNavigation,
    isPinned,
    showScrollButton,
    nearContentStart,
    activeTurnChangeRef,
    loadHistoryUntilMessageRef,
}: {
    active: boolean;
    currentSessionId: string | null;
    currentSessionKey: string | null;
    effectiveSessionDirectory: string | undefined;
    messageLoader: ReturnType<typeof useSessionMessageLoader>;
    sessionMessages: Array<{ info: Message; parts: Part[] }>;
    historyMeta: TimelineControllerArgs['historyMeta'];
    sessionIsWorking: boolean;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    scrollNode: HTMLElement | null;
    messageListRef: React.RefObject<MessageListHandle | null>;
    loadMoreMessages: TimelineControllerArgs['loadMoreMessages'];
    goToBottom: TimelineControllerArgs['goToBottom'];
    onManualNavigation: () => void;
    isPinned: boolean;
    showScrollButton: boolean;
    nearContentStart: boolean;
    activeTurnChangeRef: React.MutableRefObject<(turnId: string | null) => void>;
    loadHistoryUntilMessageRef: React.MutableRefObject<(messageId: string, maxBatches: number) => Promise<boolean>>;
}) => {
    const sessionStartTimes = useSessionStartTimes(effectiveSessionDirectory);
    const viewportMessages = React.useMemo(
        () => dropReplyCommandRows(keepCommandSubagentReports(sessionMessages, (childSessionID) => sessionStartTimes.get(childSessionID))),
        [sessionStartTimes, sessionMessages],
    );

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        messages: viewportMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom,
        releaseAutoFollow: onManualNavigation,
        isPinned,
        showScrollButton,
    });

    const newestTurnId = timelineController.turnIds[timelineController.turnIds.length - 1] ?? null;
    const isPinnedRef = React.useRef(isPinned);
    isPinnedRef.current = isPinned;
    React.useEffect(() => {
        if (!active || !currentSessionId || !effectiveSessionDirectory) return;
        const timer = window.setTimeout(() => {
            if (!isPinnedRef.current) return;
            messageLoader.trimHistory({ directory: effectiveSessionDirectory, sessionID: currentSessionId });
        }, HISTORY_TRIM_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [active, currentSessionId, effectiveSessionDirectory, messageLoader, sessionIsWorking, newestTurnId]);
    React.useEffect(() => {
        if (isPinned || !currentSessionId || !effectiveSessionDirectory) return;
        return messageLoader.retainSessionHistory({ directory: effectiveSessionDirectory, sessionID: currentSessionId }, 'browsing');
    }, [currentSessionId, effectiveSessionDirectory, isPinned, messageLoader]);

    const handleHistoryScroll = timelineController.handleHistoryScroll;
    React.useEffect(() => {
        if (!scrollNode) return;
        const onScroll = () => handleHistoryScroll();
        scrollNode.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            scrollNode.removeEventListener('scroll', onScroll);
        };
    }, [handleHistoryScroll, scrollNode]);

    const resumeToLatestInstant = React.useCallback(() => {
        goToBottom('instant');
    }, [goToBottom]);

    const showLoadOlderButton = timelineController.historySignals.canLoadEarlier && nearContentStart;
    const timelineLoadEarlier = timelineController.loadEarlier;
    const handleLoadOlderClick = React.useCallback(() => {
        onManualNavigation();
        void timelineLoadEarlier({ userInitiated: true });
    }, [onManualNavigation, timelineLoadEarlier]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [activeTurnChangeRef, timelineController.handleActiveTurnChange]);
    const controllerLoadHistoryUntilMessage = timelineController.loadHistoryUntilMessage;
    loadHistoryUntilMessageRef.current = async (messageId, maxBatches) => {
        const release = currentSessionId && effectiveSessionDirectory
            ? messageLoader.retainSessionHistory({ directory: effectiveSessionDirectory, sessionID: currentSessionId }, 'browsing')
            : null;
        try {
            return await controllerLoadHistoryUntilMessage(messageId, { maxBatches });
        } finally {
            release?.();
        }
    };

    return {
        timelineController,
        controllerLoadHistoryUntilMessage,
        resumeToLatestInstant,
        showLoadOlderButton,
        handleLoadOlderClick,
    };
};
