import React from 'react';
import { RiArrowLeftLine } from '@remixicon/react';
import { useShallow } from 'zustand/react/shallow';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { ChatInput } from './ChatInput';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import MessageList, { type MessageListHandle } from './MessageList';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useChatScrollManager } from '@/hooks/useChatScrollManager';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useDeviceInfo } from '@/lib/device';
import { ButtonSmall } from '@/components/ui/button-small';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { TimelineDialog } from './TimelineDialog';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import { cn } from '@/lib/utils';
import {
    collectVisibleSessionIdsForBlockingRequests,
    flattenBlockingRequests,
} from './lib/blockingRequests';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };

export const ChatContainer: React.FC = () => {
    const {
        currentSessionId,
        isLoading,
        loadMessages,
        loadMoreMessages,
        updateViewportAnchor,
        openNewSessionDraft,
        setCurrentSession,
        trimToViewportWindow,
        newSessionDraft,
    } = useSessionStore(
        useShallow((state) => ({
            currentSessionId: state.currentSessionId,
            isLoading: state.isLoading,
            loadMessages: state.loadMessages,
            loadMoreMessages: state.loadMoreMessages,
            updateViewportAnchor: state.updateViewportAnchor,
            openNewSessionDraft: state.openNewSessionDraft,
            setCurrentSession: state.setCurrentSession,
            trimToViewportWindow: state.trimToViewportWindow,
            newSessionDraft: state.newSessionDraft,
        }))
    );

    const { isSyncing, messageStreamStates, sessionMemoryStateMap } = useSessionStore(
        useShallow((state) => ({
            isSyncing: state.isSyncing,
            messageStreamStates: state.messageStreamStates,
            sessionMemoryStateMap: state.sessionMemoryState,
        }))
    );

    const {
        isTimelineDialogOpen,
        setTimelineDialogOpen,
        isExpandedInput,
        stickyUserHeader,
    } = useUIStore();

    const sessionMessages = useSessionStore(
        React.useCallback(
            (state) => (currentSessionId ? state.messages.get(currentSessionId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES),
            [currentSessionId]
        )
    );

    const sessions = useSessionStore((state) => state.sessions);

    const blockingRequestState = useSessionStore(
        useShallow((state) => ({
            sessions: state.sessions,
            permissions: state.permissions,
            questions: state.questions,
        }))
    );

    const scopedSessionIds = React.useMemo(
        () => collectVisibleSessionIdsForBlockingRequests(
            blockingRequestState.sessions.map((session) => ({ id: session.id, parentID: session.parentID })),
            currentSessionId,
        ),
        [blockingRequestState.sessions, currentSessionId]
    );

    const sessionPermissions = React.useMemo(() => {
        if (scopedSessionIds.length === 0) return EMPTY_PERMISSIONS;
        return flattenBlockingRequests(blockingRequestState.permissions, scopedSessionIds);
    }, [blockingRequestState.permissions, scopedSessionIds]);

    const sessionQuestions = React.useMemo(() => {
        if (scopedSessionIds.length === 0) return EMPTY_QUESTIONS;
        return flattenBlockingRequests(blockingRequestState.questions, scopedSessionIds);
    }, [blockingRequestState.questions, scopedSessionIds]);

    const historyMeta = useSessionStore(
        React.useCallback(
            (state) => (currentSessionId ? state.sessionHistoryMeta.get(currentSessionId) ?? null : null),
            [currentSessionId]
        )
    );

    const streamingMessageId = useSessionStore(
        React.useCallback(
            (state) => (currentSessionId ? state.streamingMessageIds.get(currentSessionId) ?? null : null),
            [currentSessionId]
        )
    );

    const sessionStatusForCurrent = useSessionStore(
        React.useCallback(
            (state) => (currentSessionId ? state.sessionStatus?.get(currentSessionId) ?? IDLE_SESSION_STATUS : IDLE_SESSION_STATUS),
            [currentSessionId]
        )
    );

    const hasSessionMessagesEntry = useSessionStore(
        React.useCallback((state) => (currentSessionId ? state.messages.has(currentSessionId) : false), [currentSessionId])
    );

    const { isMobile } = useDeviceInfo();
    const draftOpen = Boolean(newSessionDraft?.open);
    const isDesktopExpandedInput = isExpandedInput && !isMobile;
    const messageListRef = React.useRef<MessageListHandle | null>(null);

    const parentSession = React.useMemo(() => {
        if (!currentSessionId) {
            return null;
        }

        const current = sessions.find((session) => session.id === currentSessionId);
        const parentID = current?.parentID;
        if (!parentID) {
            return null;
        }

        return sessions.find((session) => session.id === parentID) ?? null;
    }, [currentSessionId, sessions]);

    const handleReturnToParentSession = React.useCallback(() => {
        if (!parentSession) {
            return;
        }
        void setCurrentSession(parentSession.id);
    }, [parentSession, setCurrentSession]);

    const returnToParentButton = parentSession ? (
        <ButtonSmall
            type="button"
            variant="outline"
            size="xs"
            onClick={handleReturnToParentSession}
            className="absolute left-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95"
            aria-label="Return to parent session"
            title={parentSession.title?.trim() ? `Return to: ${parentSession.title}` : 'Return to parent session'}
        >
            <RiArrowLeftLine className="h-4 w-4" />
            Parent
        </ButtonSmall>
    ) : null;

    React.useEffect(() => {
        if (!currentSessionId && !draftOpen) {
            openNewSessionDraft();
        }
    }, [currentSessionId, draftOpen, openNewSessionDraft]);

    const sessionBlockingCards = React.useMemo(() => {
        return [...sessionPermissions, ...sessionQuestions];
    }, [sessionPermissions, sessionQuestions]);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});

    const {
        scrollRef,
        handleMessageContentChange,
        getAnimationHandlers,
        scrollToBottom,
        isPinned,
        isOverflowing,
    } = useChatScrollManager({
        currentSessionId,
        sessionMessages,
        streamingMessageId,
        sessionMemoryState: sessionMemoryStateMap,
        updateViewportAnchor,
        isSyncing,
        isMobile,
        messageStreamStates,
        sessionPermissions: sessionBlockingCards,
        trimToViewportWindow,
        onActiveTurnChange: (turnId) => {
            activeTurnChangeRef.current(turnId);
        },
    });

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        messages: sessionMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        scrollToBottom,
        isPinned,
        isOverflowing,
    });

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [timelineController.handleActiveTurnChange]);

    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottom,
    });

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) {
            return;
        }

        const updateChatScrollHeight = () => {
            container.style.setProperty('--chat-scroll-height', `${container.clientHeight}px`);
        };

        updateChatScrollHeight();

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', updateChatScrollHeight);
            return () => {
                window.removeEventListener('resize', updateChatScrollHeight);
            };
        }

        const resizeObserver = new ResizeObserver(updateChatScrollHeight);
        resizeObserver.observe(container);

        return () => {
            resizeObserver.disconnect();
        };
    }, [currentSessionId, isDesktopExpandedInput, scrollRef]);

    const hasHistoryMetadata = React.useMemo(() => {
        return Boolean(historyMeta);
    }, [historyMeta]);

    React.useEffect(() => {
        if (!currentSessionId) {
            return;
        }

        const hasSessionMessages = hasSessionMessagesEntry;
        if (hasSessionMessages && hasHistoryMetadata) {
            return;
        }

        const load = async () => {
            await loadMessages(currentSessionId).finally(() => {
                const statusType = sessionStatusForCurrent.type ?? 'idle';
                const isActivePhase = statusType === 'busy' || statusType === 'retry';
                const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
                const shouldSkipScroll = (isActivePhase && isPinned) || hasHashTarget;

                if (!shouldSkipScroll) {
                    if (typeof window === 'undefined') {
                        scrollToBottom({ instant: true });
                    } else {
                        window.requestAnimationFrame(() => {
                            scrollToBottom({ instant: true });
                        });
                    }
                }
            });
        };

        void load();
    }, [currentSessionId, hasHistoryMetadata, hasSessionMessagesEntry, isPinned, loadMessages, scrollToBottom, sessionMessages.length, sessionStatusForCurrent.type]);

    if (!currentSessionId && !draftOpen) {
        return (
            <div
                className="flex flex-col h-full bg-background"
                style={isMobile ? { paddingBottom: 'var(--oc-keyboard-inset, 0px)' } : undefined}
            >
                <ChatEmptyState />
            </div>
        );
    }

    if (!currentSessionId && draftOpen) {
        return (
            <div
                className="relative flex flex-col h-full bg-background transform-gpu"
                style={isMobile ? { paddingBottom: 'var(--oc-keyboard-inset, 0px)' } : undefined}
            >
                {!isDesktopExpandedInput ? (
                <div className="flex-1 flex items-center justify-center">
                    <ChatEmptyState showDraftContext />
                </div>
                ) : null}
                <div
                    className={cn(
                        'relative z-10',
                        isDesktopExpandedInput
                            ? 'flex-1 min-h-0 bg-background'
                            : 'bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80'
                    )}
                >
                    <ChatInput scrollToBottom={scrollToBottom} />
                </div>
            </div>
        );
    }

    if (!currentSessionId) {
        return null;
    }

    if (isLoading && sessionMessages.length === 0 && !streamingMessageId) {
        const hasMessagesEntry = hasSessionMessagesEntry;
        if (!hasMessagesEntry) {
            return (
                <div
                    className="relative flex flex-col h-full bg-background gap-0"
                    style={isMobile ? { paddingBottom: 'var(--oc-keyboard-inset, 0px)' } : undefined}
                >
                    {returnToParentButton}
                    <div className="flex-1 overflow-y-auto p-4 bg-background">
                        <div className="chat-message-column space-y-4">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="flex gap-3 p-4">
                                    <Skeleton className="h-8 w-8 rounded-full" />
                                    <div className="flex-1 space-y-2">
                                        <Skeleton className="h-4 w-24" />
                                        <Skeleton className="h-20 w-full" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <ChatInput scrollToBottom={scrollToBottom} />
                </div>
            );
        }
    }

    if (sessionMessages.length === 0 && !streamingMessageId) {
        return (
            <div
                className="relative flex flex-col h-full bg-background transform-gpu"
                style={isMobile ? { paddingBottom: 'var(--oc-keyboard-inset, 0px)' } : undefined}
            >
                {returnToParentButton}
                {!isDesktopExpandedInput ? (
                <div className="flex-1 flex items-center justify-center">
                    <ChatEmptyState />
                </div>
                ) : null}
                <div
                    className={cn(
                        'relative z-10',
                        isDesktopExpandedInput
                            ? 'flex-1 min-h-0 bg-background'
                            : 'bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80'
                    )}
                >
                    <ChatInput scrollToBottom={scrollToBottom} />
                </div>
            </div>
        );
    }

    return (
        <div
            className="relative flex flex-col h-full bg-background"
            style={isMobile ? { paddingBottom: 'var(--oc-keyboard-inset, 0px)' } : undefined}
        >
            {returnToParentButton}
            <div
                className={cn(
                    'relative min-h-0',
                    isDesktopExpandedInput
                        ? 'absolute inset-0 opacity-0 pointer-events-none'
                        : 'flex-1'
                )}
                aria-hidden={isDesktopExpandedInput}
            >
                <div className="absolute inset-0">
                        <ScrollShadow
                            className="absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target"
                            ref={scrollRef}
                            observeMutations={false}
                            hideTopShadow={isMobile && stickyUserHeader}
                            data-scroll-shadow="true"
                            data-scrollbar="chat"
                        >
                        <div className="relative z-0 min-h-full">
                            <MessageList
                                ref={messageListRef}
                                sessionKey={currentSessionId}
                                turnStart={timelineController.turnStart}
                                disableStaging={timelineController.pendingRevealWork}
                                messages={timelineController.renderedMessages}
                                permissions={sessionPermissions}
                                questions={sessionQuestions}
                                onMessageContentChange={handleMessageContentChange}
                                getAnimationHandlers={getAnimationHandlers}
                                hasMoreAbove={timelineController.historySignals.hasMoreAboveTurns}
                                isLoadingOlder={timelineController.isLoadingOlder}
                                onLoadOlder={() => {
                                    void timelineController.loadEarlier();
                                }}
                                scrollToBottom={scrollToBottom}
                                scrollRef={scrollRef}
                            />
                        </div>
                    </ScrollShadow>
                    <OverlayScrollbar containerRef={scrollRef} />
                </div>
            </div>

            <div
                className={cn(
                    'relative z-10',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : 'bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80'
                )}
            >
                {!isDesktopExpandedInput && sessionMessages.length > 0 && (
                    <ScrollToBottomButton
                        visible={timelineController.showScrollToBottom}
                        onClick={navigation.resumeToLatest}
                    />
                )}
                <ChatInput scrollToBottom={scrollToBottom} />
            </div>

            <TimelineDialog
                open={isTimelineDialogOpen}
                onOpenChange={setTimelineDialogOpen}
                onScrollToMessage={(messageId) => {
                    void navigation.scrollToMessageId(messageId, { behavior: 'smooth' });
                }}
                onScrollByTurnOffset={(offset) => {
                    void navigation.scrollByTurnOffset(offset);
                }}
                onResumeToLatest={navigation.resumeToLatest}
            />
        </div>
    );
};
