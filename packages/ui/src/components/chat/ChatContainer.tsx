import React from 'react';
import { RiArrowLeftLine } from '@remixicon/react';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { ChatInput } from './ChatInput';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import MessageList, { type MessageListHandle } from './MessageList';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useChatScrollManager } from '@/hooks/useChatScrollManager';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useTimelineStaging } from '@/hooks/useTimelineStaging';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import { cn } from '@/lib/utils';
import {
    collectVisibleSessionIdsForBlockingRequests,
    flattenBlockingRequests,
} from './lib/blockingRequests';

// New sync system imports
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useViewportStore } from '@/sync/viewport-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useSessionMessageRecords,
    useSessions,
    useDirectorySync,
    useSessionStatus,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { getAllSyncSessions } from '@/sync/sync-refs';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };
const SESSION_RESELECTED_EVENT = 'openchamber:session-reselected';

type HydratingToolSkeletonRow = {
    id: string;
    titleWidth: string;
    detailWidth: string;
};

const HYDRATING_SKELETON_ITEMS: Array<{
    id: number;
    toolRows: HydratingToolSkeletonRow[];
    textWidths: [string, string, string];
}> = [
    {
        id: 1,
        toolRows: [
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-52' },
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-36' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-64' },
        ],
        textWidths: ['w-24', 'w-[92%]', 'w-[78%]'],
    },
    {
        id: 2,
        toolRows: [
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-40' },
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-48' },
        ],
        textWidths: ['w-20', 'w-[88%]', 'w-[70%]'],
    },
    {
        id: 3,
        toolRows: [
            { id: 'shell', titleWidth: 'w-28', detailWidth: 'w-44' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-56' },
        ],
        textWidths: ['w-24', 'w-[84%]', 'w-[64%]'],
    },
];

export const ChatContainer: React.FC = () => {
    // Session UI state
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const updateViewportAnchor = useViewportStore((s) => s.updateViewportAnchor);
    const isSyncing = useViewportStore((s) => s.isSyncing);
    const sessionMemoryStateMap = useViewportStore((s) => s.sessionMemoryState);

    // Sync actions
    const sync = useSync();
    const loadMessages = React.useCallback(
        (sessionId: string) => sync.syncSession(sessionId),
        [sync],
    );
    const loadMoreMessages = React.useCallback(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        (sessionId: string, _direction: 'up' | 'down') => sync.loadMore(sessionId),
        [sync],
    );

    // UI store
    const { isExpandedInput, stickyUserHeader, chatRenderMode } = useUIStore();

    // Streaming state
    const streamingMessageId = useStreamingStore(
        React.useCallback(
            (s) => (currentSessionId ? s.streamingMessageIds.get(currentSessionId) ?? null : null),
            [currentSessionId],
        ),
    );
    // Messages from sync system
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '');
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;

    // Sessions from sync system
    const sessions = useSessions();

    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '') ?? IDLE_SESSION_STATUS;

    // Permissions & questions from sync system
    const allPermissions = useDirectorySync(
        React.useCallback((s) => s.permission ?? {}, []),
    );
    const allQuestions = useDirectorySync(
        React.useCallback((s) => s.question ?? {}, []),
    );

    // Convert Record → Map for blockingRequests helpers
    const permissionsMap = React.useMemo(() => {
        const m = new Map<string, PermissionRequest[]>();
        for (const [k, v] of Object.entries(allPermissions)) m.set(k, v as PermissionRequest[]);
        return m;
    }, [allPermissions]);

    const questionsMap = React.useMemo(() => {
        const m = new Map<string, QuestionRequest[]>();
        for (const [k, v] of Object.entries(allQuestions)) m.set(k, v as QuestionRequest[]);
        return m;
    }, [allQuestions]);

    const scopedSessionIds = React.useMemo(
        () => collectVisibleSessionIdsForBlockingRequests(
            sessions.map((session) => ({ id: session.id, parentID: session.parentID })),
            currentSessionId,
        ),
        [sessions, currentSessionId],
    );

    const sessionPermissions = React.useMemo(() => {
        if (scopedSessionIds.length === 0) return EMPTY_PERMISSIONS;
        return flattenBlockingRequests(permissionsMap, scopedSessionIds);
    }, [permissionsMap, scopedSessionIds]);

    const sessionQuestions = React.useMemo(() => {
        if (scopedSessionIds.length === 0) return EMPTY_QUESTIONS;
        return flattenBlockingRequests(questionsMap, scopedSessionIds);
    }, [questionsMap, scopedSessionIds]);

    // History metadata — use sync's hasMore/isLoading
    const historyMeta = React.useMemo(() => {
        if (!currentSessionId) return null;
        return {
            limit: sessionMessages.length,
            complete: !sync.hasMore(currentSessionId),
            loading: sync.isLoading(currentSessionId),
        };
    }, [currentSessionId, sessionMessages.length, sync]);

    const hasSessionMessagesEntry = sessionMessages.length > 0 || (currentSessionId ? sync.hasMore(currentSessionId) : false);

    const { isMobile } = useDeviceInfo();
    const draftOpen = Boolean(newSessionDraft?.open);
    const isDesktopExpandedInput = isExpandedInput && !isMobile;
    const messageListRef = React.useRef<MessageListHandle | null>(null);

    const parentSession = React.useMemo(() => {
        if (!currentSessionId) return null;
        const current = sessions.find((session) => session.id === currentSessionId);
        const parentID = current?.parentID;
        if (!parentID) return null;
        return sessions.find((session) => session.id === parentID)
            ?? getAllSyncSessions().find((session) => session.id === parentID)
            ?? null;
    }, [currentSessionId, sessions]);

    const handleReturnToParentSession = React.useCallback(() => {
        if (!parentSession) return;
        setCurrentSession(parentSession.id);
    }, [parentSession, setCurrentSession]);

    const returnToParentButton = parentSession ? (
        <Button
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
        </Button>
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
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);

    const {
        scrollRef,
        handleMessageContentChange,
        getAnimationHandlers,
        scrollToBottom,
        isPinned,
        isOverflowing,
        isProgrammaticFollowActive,
    } = useChatScrollManager({
        currentSessionId,
        sessionMessages,
        streamingMessageId,
        sessionMemoryState: sessionMemoryStateMap,
        updateViewportAnchor,
        isSyncing,
        isMobile,
        chatRenderMode,
        sessionPermissions: sessionBlockingCards,
        onActiveTurnChange: handleActiveTurnChange,
    });

    // Deferred timeline staging — renders 1 message on first paint,
    // adds 3 per rAF frame to avoid blocking.
    const { stagedMessages } = useTimelineStaging({
        sessionKey: currentSessionId ?? '',
        messages: sessionMessages,
    });

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        messages: stagedMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        scrollToBottom,
        isPinned,
        isOverflowing,
    });
    const { resumeToBottomInstant } = timelineController;

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

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId) return;

        const handleSessionReselected = (event: Event) => {
            const customEvent = event as CustomEvent<string>;
            if (customEvent.detail !== currentSessionId) return;
            resumeToBottomInstant();
        };

        window.addEventListener(SESSION_RESELECTED_EVENT, handleSessionReselected as EventListener);
        return () => {
            window.removeEventListener(SESSION_RESELECTED_EVENT, handleSessionReselected as EventListener);
        };
    }, [currentSessionId, resumeToBottomInstant]);

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const updateChatScrollHeight = () => {
            container.style.setProperty('--chat-scroll-height', `${container.clientHeight}px`);
        };

        updateChatScrollHeight();

        let rafId = 0;
        const scheduleUpdate = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                updateChatScrollHeight();
            });
        };

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', scheduleUpdate);
            return () => {
                if (rafId) cancelAnimationFrame(rafId);
                window.removeEventListener('resize', scheduleUpdate);
            };
        }

        const resizeObserver = new ResizeObserver(scheduleUpdate);
        resizeObserver.observe(container);

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            resizeObserver.disconnect();
        };
    }, [currentSessionId, isDesktopExpandedInput, scrollRef]);

    const hasHistoryMetadata = Boolean(historyMeta);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && (!hasSessionMessagesEntry || !hasHistoryMetadata || historyMeta?.loading === true);

    React.useEffect(() => {
        if (!currentSessionId) return;
        if (hasSessionMessagesEntry && hasHistoryMetadata) return;

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
                    <ChatEmptyState />
                </div>
                ) : null}
                <div
                    className={cn(
                        'relative z-10',
                        isDesktopExpandedInput
                            ? 'flex-1 min-h-0 bg-background'
                            : 'bg-background/95 supports-[backdrop-filter]:bg-background/80'
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

    if (isSessionHydrating && sessionMessages.length === 0 && !streamingMessageId) {
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
                    <div className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background pt-6">
                        <div className="space-y-4">
                            {HYDRATING_SKELETON_ITEMS.map((item) => (
                                <div key={item.id} className="group w-full">
                                    <div className="chat-message-column">
                                        <div className="space-y-2.5 px-4 py-3">
                                            <div className="space-y-1.5">
                                                {item.toolRows.map((row) => {
                                                    return (
                                                        <div key={`${item.id}-${row.id}`} className="flex items-center gap-2">
                                                            <Skeleton className="h-3.5 w-3.5 rounded-full flex-shrink-0" />
                                                            <Skeleton className={cn('h-4 rounded-md', row.titleWidth)} />
                                                            <Skeleton className={cn('h-4 rounded-md', row.detailWidth)} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="space-y-1.5 pt-1">
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[0])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[1])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[2])} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <div
                    className={cn(
                        'relative z-10',
                        isDesktopExpandedInput
                            ? 'flex-1 min-h-0 bg-background'
                            : 'bg-background/95 supports-[backdrop-filter]:bg-background/80'
                    )}
                >
                    <ChatInput scrollToBottom={scrollToBottom} />
                </div>
            </div>
        );
    }

    if (sessionMessages.length === 0 && !streamingMessageId) {
        return (
            <div
                className="relative flex flex-col h-full bg-background transform-gpu"
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
                    {!isDesktopExpandedInput ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <ChatEmptyState />
                        </div>
                    ) : null}
                </div>
                <div
                    className={cn(
                        'relative z-10',
                        isDesktopExpandedInput
                            ? 'flex-1 min-h-0 bg-background'
                            : 'bg-background/95 supports-[backdrop-filter]:bg-background/80'
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
                            style={(timelineController.pendingRevealWork || timelineController.isLoadingOlder)
                                ? { overflowAnchor: 'none' }
                                : undefined}
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
                    <OverlayScrollbar containerRef={scrollRef} suppressVisibility={isProgrammaticFollowActive} userIntentOnly />
                </div>
            </div>

            <div
                className={cn(
                    'relative z-10',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : 'bg-background/95 supports-[backdrop-filter]:bg-background/80'
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
        </div>
    );
};
