import React from 'react';
import type { Message, Part } from '@/lib/opencode/model';
import { keepCommandSubagentReports } from '@/lib/opencode/subagent-run';
import { dropReplyCommandRows } from '@/lib/opencode/reply-command';
import { useSessionStartTimes, useSessionMessageLoader } from '@/sync/sync-context';
import { useChatTimelineController } from '../hooks/useChatTimelineController';
import type { MessageListHandle } from '../MessageList';

// After a turn starts or ends, how long the transcript settles before an
// overgrown history is cut back: past the scroll hook's 2 s send glide and
// 1 s turn-end glide windows.
const HISTORY_TRIM_DELAY_MS = 3000;

type TimelineControllerArgs = Parameters<typeof useChatTimelineController>[0];

/**
 * The timeline controller of the shown session and the history the column
 * holds for it: what the viewport renders, paging older turns in, trimming an
 * overgrown history, and the load-older button.
 */
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
    // A subagent report opens a turn of its own at the end of the chat only for
    // a `subagent: true` command; a call's report finishes that call's row
    // (see `ToolPart`), and a run started before the loaded history stays in
    // the session's subagent list, so the chat never shifts for either. A
    // command run from a code block of a reply shows in that block.
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

    // A transcript someone works in keeps every turn it receives, and every
    // timeline pass walks all of them. When a turn starts or ends with the
    // reader at the end, the loader cuts what outgrew the cold-navigation
    // window back to it; the older turns load again on scroll, as in a freshly
    // opened session. Both edges count, since queued prompts and agent loops
    // start the next turn the moment one ends. The pause lets the send glide,
    // the turn's last block, its footer and the turn-end glide land first. A
    // reader away from the end holds the history, so another column showing
    // this session never cuts what they look at.
    // Prepending older turns must not re-arm the trim timer.
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

    // A window too short to scroll must stay manually pageable on every runtime.
    const showLoadOlderButton = timelineController.historySignals.canLoadEarlier && nearContentStart;
    const timelineLoadEarlier = timelineController.loadEarlier;
    const handleLoadOlderClick = React.useCallback(() => {
        // Loading older history is an explicit move INTO the past: release
        // live follow first, or the prepend's content growth would trigger an
        // end correction and throw the viewport to the bottom.
        onManualNavigation();
        void timelineLoadEarlier({ userInitiated: true });
    }, [onManualNavigation, timelineLoadEarlier]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [activeTurnChangeRef, timelineController.handleActiveTurnChange]);
    // Assigned during render: the entry restore runs in a layout effect of
    // this same commit, before passive effects could update the ref.
    const controllerLoadHistoryUntilMessage = timelineController.loadHistoryUntilMessage;
    // The reader sits at the end while this search loads the history above
    // them, which is when the history trim cuts it: the search holds the
    // history as a reader browsing it does, or a cut would send it back to
    // the start.
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
