import React from 'react';
import { RiArrowDownLine } from '@remixicon/react';
import { useShallow } from 'zustand/react/shallow';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { ChatInput } from './ChatInput';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import MessageList, { type MessageListHandle } from './MessageList';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useChatScrollManager } from '@/hooks/useChatScrollManager';
import { useDeviceInfo } from '@/lib/device';
import { getMemoryLimits } from '@/stores/types/sessionTypes';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { TimelineDialog } from './TimelineDialog';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import { cn } from '@/lib/utils';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };

const collectVisibleSessionIdsForBlockingRequests = (
    sessions: Array<{ id: string; parentID?: string }> | undefined,
    currentSessionId: string | null
): string[] => {
    if (!currentSessionId) return [];
    if (!Array.isArray(sessions) || sessions.length === 0) return [currentSessionId];

    const current = sessions.find((session) => session.id === currentSessionId);
    if (!current) return [currentSessionId];

    // Opencode parity: when viewing a child session, permission/question prompts are handled in parent thread.
    if (current.parentID) {
        return [];
    }

    const childIds = sessions
        .filter((session) => session.parentID === currentSessionId)
        .map((session) => session.id);

    return [currentSessionId, ...childIds];
};

const flattenBlockingRequests = <T extends { id: string }>(
    source: Map<string, T[]>,
    sessionIds: string[]
): T[] => {
    if (sessionIds.length === 0) return [];
    const seen = new Set<string>();
    const result: T[] = [];

    for (const sessionId of sessionIds) {
        const entries = source.get(sessionId);
        if (!entries || entries.length === 0) continue;
        for (const entry of entries) {
            if (seen.has(entry.id)) continue;
            seen.add(entry.id);
            result.push(entry);
        }
    }

    return result;
};

export const ChatContainer: React.FC = () => {
    const {
        currentSessionId,
        isLoading,
        loadMessages,
        loadMoreMessages,
        updateViewportAnchor,
        openNewSessionDraft,
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
    } = useUIStore();

    const sessionMessages = useSessionStore(
        React.useCallback(
            (state) => (currentSessionId ? state.messages.get(currentSessionId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES),
            [currentSessionId]
        )
    );

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

    const memoryState = useSessionStore(
        React.useCallback(
            (state) => (currentSessionId ? state.sessionMemoryState.get(currentSessionId) ?? null : null),
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

    React.useEffect(() => {
        if (!currentSessionId && !draftOpen) {
            openNewSessionDraft();
        }
    }, [currentSessionId, draftOpen, openNewSessionDraft]);

    const [turnStart, setTurnStart] = React.useState(0);
    const turnHandleRef = React.useRef<number | null>(null);
    const turnIdleRef = React.useRef(false);
    const initializedTurnStartSessionRef = React.useRef<string | null>(null);
    const TURN_INIT = 5;
    const TURN_BATCH = 8;

    const userTurnIndexes = React.useMemo(() => {
        const indexes: number[] = [];
        for (let i = 0; i < sessionMessages.length; i += 1) {
            const message = sessionMessages[i];
            const role = (message.info as { clientRole?: string | null | undefined }).clientRole ?? message.info.role;
            if (role === 'user') {
                indexes.push(i);
            }
        }
        return indexes;
    }, [sessionMessages]);

    const cancelTurnBackfill = React.useCallback(() => {
        const handle = turnHandleRef.current;
        if (handle === null) {
            return;
        }
        turnHandleRef.current = null;
        if (turnIdleRef.current && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(handle);
            return;
        }
        if (typeof window !== 'undefined') {
            window.clearTimeout(handle);
        }
    }, []);

    const renderedSessionMessages = React.useMemo(() => {
        if (turnStart <= 0 || userTurnIndexes.length === 0) {
            return sessionMessages;
        }
        const startIndex = userTurnIndexes[turnStart] ?? 0;
        return sessionMessages.slice(startIndex);
    }, [sessionMessages, turnStart, userTurnIndexes]);

    const backfillTurns = React.useCallback(() => {
        if (turnStart <= 0) {
            return;
        }

        const container = typeof document !== 'undefined'
            ? (document.querySelector('[data-scrollbar="chat"]') as HTMLDivElement | null)
            : null;
        const beforeTop = container?.scrollTop ?? null;
        const beforeHeight = container?.scrollHeight ?? null;

        setTurnStart((prev) => (prev - TURN_BATCH > 0 ? prev - TURN_BATCH : 0));

        if (container && beforeTop !== null && beforeHeight !== null) {
            window.requestAnimationFrame(() => {
                const delta = container.scrollHeight - beforeHeight;
                if (delta !== 0) {
                    container.scrollTop = beforeTop + delta;
                }
            });
        }
    }, [turnStart]);

    const scheduleTurnBackfill = React.useCallback(() => {
        if (turnHandleRef.current !== null || turnStart <= 0) {
            return;
        }

        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            turnIdleRef.current = true;
            turnHandleRef.current = window.requestIdleCallback(() => {
                turnHandleRef.current = null;
                backfillTurns();
            });
            return;
        }

        turnIdleRef.current = false;
        turnHandleRef.current = window.setTimeout(() => {
            turnHandleRef.current = null;
            backfillTurns();
        }, 0);
    }, [backfillTurns, turnStart]);

    const sessionBlockingCards = React.useMemo(() => {
        return [...sessionPermissions, ...sessionQuestions];
    }, [sessionPermissions, sessionQuestions]);

    const {
        scrollRef,
        handleMessageContentChange,
        getAnimationHandlers,
        showScrollButton,
        scrollToBottom,
        scrollToPosition,
        isPinned,
    } = useChatScrollManager({
        currentSessionId,
        sessionMessages: renderedSessionMessages,
        streamingMessageId,
        sessionMemoryState: sessionMemoryStateMap,
        updateViewportAnchor,
        isSyncing,
        isMobile,
        messageStreamStates,
        sessionPermissions: sessionBlockingCards,
        trimToViewportWindow,
    });

    React.useEffect(() => {
        cancelTurnBackfill();
        if (!currentSessionId) {
            initializedTurnStartSessionRef.current = null;
            setTurnStart(0);
            return;
        }

        if (initializedTurnStartSessionRef.current === currentSessionId) {
            return;
        }

        if (sessionMessages.length === 0) {
            setTurnStart(0);
            return;
        }

        const turnCount = userTurnIndexes.length;
        const start = turnCount > TURN_INIT ? turnCount - TURN_INIT : 0;
        setTurnStart(start);
        initializedTurnStartSessionRef.current = currentSessionId;
    }, [cancelTurnBackfill, currentSessionId, sessionMessages.length, userTurnIndexes.length]);

    const isSessionActive = sessionStatusForCurrent.type === 'busy' || sessionStatusForCurrent.type === 'retry';

    React.useEffect(() => {
        if (isSessionActive) {
            cancelTurnBackfill();
            return;
        }
        scheduleTurnBackfill();
        return () => {
            cancelTurnBackfill();
        };
    }, [cancelTurnBackfill, isSessionActive, scheduleTurnBackfill, turnStart]);

    const hasMoreAbove = React.useMemo(() => {
        if (!memoryState) {
            return sessionMessages.length >= getMemoryLimits().HISTORICAL_MESSAGES;
        }
        if (memoryState.historyComplete === true) {
            return false;
        }
        if (memoryState.hasMoreAbove) {
            return true;
        }
        if (memoryState.historyComplete === false) {
            return true;
        }

        // Backward compatibility: older persisted sessions may miss history flags.
        if (memoryState.hasMoreAbove === undefined && memoryState.historyComplete === undefined) {
            return sessionMessages.length >= getMemoryLimits().HISTORICAL_MESSAGES;
        }

        return false;
    }, [memoryState, sessionMessages.length]);

    const hasHistoryMetadata = React.useMemo(() => {
        if (!memoryState) {
            return false;
        }
        return memoryState.hasMoreAbove !== undefined || memoryState.historyComplete !== undefined;
    }, [memoryState]);
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    React.useEffect(() => {
        setIsLoadingOlder(false);
    }, [currentSessionId]);

    const handleLoadOlder = React.useCallback(async () => {
        if (!currentSessionId || isLoadingOlder) {
            return;
        }

        cancelTurnBackfill();
        setTurnStart(0);

        const container = scrollRef.current;
        const anchor = messageListRef.current?.captureViewportAnchor() ?? null;
        const prevHeight = container?.scrollHeight ?? null;
        const prevTop = container?.scrollTop ?? null;

        setIsLoadingOlder(true);
        void loadMoreMessages(currentSessionId, 'up')
            .then(() => {
                const restored = anchor ? (messageListRef.current?.restoreViewportAnchor(anchor) ?? false) : false;
                if (!restored && container && prevHeight !== null && prevTop !== null) {
                    const heightDiff = container.scrollHeight - prevHeight;
                    scrollToPosition(prevTop + heightDiff, { instant: true });
                }
            })
            .finally(() => {
                setIsLoadingOlder(false);
            });
    }, [cancelTurnBackfill, currentSessionId, isLoadingOlder, loadMoreMessages, scrollRef, scrollToPosition]);

    const handleRenderEarlier = React.useCallback(() => {
        cancelTurnBackfill();
        setTurnStart(0);
    }, [cancelTurnBackfill]);

    // Scroll to a specific message by ID (for timeline dialog)
    const scrollToMessage = React.useCallback((messageId: string) => {
        if (messageListRef.current?.scrollToMessageId(messageId, { behavior: 'smooth' })) {
            return;
        }

        const container = scrollRef.current;
        if (!container) return;

        // Find the message element by looking for data-message-id attribute
        const messageElement = container.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement;
        if (messageElement) {
            // Scroll to the message with some padding (50px from top)
            const containerRect = container.getBoundingClientRect();
            const messageRect = messageElement.getBoundingClientRect();
            const offset = 50;

            const scrollTop = messageRect.top - containerRect.top + container.scrollTop - offset;
            container.scrollTo({
                top: scrollTop,
                behavior: 'smooth'
            });
        }
    }, [scrollRef]);

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
                const shouldSkipScroll = isActivePhase && isPinned;

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
                    className="flex flex-col h-full bg-background gap-0"
                    style={isMobile ? { paddingBottom: 'var(--oc-keyboard-inset, 0px)' } : undefined}
                >
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
                        hideTopShadow={isMobile}
                        data-scroll-shadow="true"
                        data-scrollbar="chat"
                    >
                        <div className="relative z-0 min-h-full">
                            <MessageList
                                ref={messageListRef}
                                messages={renderedSessionMessages}
                                permissions={sessionPermissions}
                                questions={sessionQuestions}
                                onMessageContentChange={handleMessageContentChange}
                                getAnimationHandlers={getAnimationHandlers}
                                hasMoreAbove={hasMoreAbove}
                                isLoadingOlder={isLoadingOlder}
                                onLoadOlder={handleLoadOlder}
                                hasRenderEarlier={turnStart > 0}
                                onRenderEarlier={handleRenderEarlier}
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
                {!isDesktopExpandedInput && showScrollButton && sessionMessages.length > 0 && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => scrollToBottom({ force: true })}
                                  className="rounded-full h-8 w-8 p-0 shadow-none bg-background/95 hover:bg-interactive-hover"
                                  aria-label="Scroll to bottom"
                                >

                            <RiArrowDownLine className="h-4 w-4" />
                        </Button>
                    </div>
                )}
                <ChatInput scrollToBottom={scrollToBottom} />
            </div>

            <TimelineDialog
                open={isTimelineDialogOpen}
                onOpenChange={setTimelineDialogOpen}
                onScrollToMessage={scrollToMessage}
            />
        </div>
    );
};
