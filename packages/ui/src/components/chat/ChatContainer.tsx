import React from 'react';
import { RiArrowLeftLine } from '@remixicon/react';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2';

import { ChatInput } from './ChatInput';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import MessageList, { type MessageListHandle } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { StatusRowContainer } from './StatusRowContainer';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useChatScrollManager, type AnimationHandlers, type ContentChangeReason } from '@/hooks/useChatScrollManager';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
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
    useSessionMessageCount,
    useSessionMessageRecords,
    useSessions,
    useDirectorySync,
    useSessionStatus,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { usePlanDetection } from '@/hooks/usePlanDetection';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useI18n } from '@/lib/i18n';

import { EMPTY_OBJECT, EMPTY_PERMISSION_REQUESTS, EMPTY_QUESTION_REQUESTS, emptyArray } from '@/constants/empty';
const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = emptyArray<{ info: Message; parts: Part[] }>() as Array<{ info: Message; parts: Part[] }>;
const IDLE_SESSION_STATUS = { type: 'idle' as const };
const SESSION_RESELECTED_EVENT = 'openchamber:session-reselected';
const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';
const CHAT_SCROLL_STYLE = {
    overflowAnchor: 'none',
    overscrollBehavior: 'contain',
    overscrollBehaviorY: 'contain',
} as const;
const CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="combobox"]',
    '[role="dialog"]',
    '[role="listbox"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="textbox"]',
    '[data-radix-popper-content-wrapper]',
].join(',');
type SessionMessageRecord = { info: Message; parts: Part[] };

const isHTMLElement = (target: EventTarget | null): target is HTMLElement => {
    return target instanceof HTMLElement;
};

const shouldIgnoreChatNavigationTarget = (target: EventTarget | null): boolean => {
    if (!isHTMLElement(target)) {
        return false;
    }

    return Boolean(target.closest(CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR));
};

const shouldIgnoreChatNavigationForFocus = (activeElement: Element | null, scrollContainer: HTMLElement | null): boolean => {
    if (typeof document === 'undefined') {
        return true;
    }

    if (!activeElement || activeElement === document.body || activeElement === document.documentElement) {
        return true;
    }

    if (shouldIgnoreChatNavigationTarget(activeElement)) {
        return true;
    }

    return !scrollContainer?.contains(activeElement);
};

const hasBlockingChatOverlay = (): boolean => {
    const {
        isAboutDialogOpen,
        isCommandPaletteOpen,
        isHelpDialogOpen,
        isImagePreviewOpen,
        isMultiRunLauncherOpen,
        isSessionSwitcherOpen,
        isSettingsDialogOpen,
    } = useUIStore.getState();

    return isAboutDialogOpen
        || isCommandPaletteOpen
        || isHelpDialogOpen
        || isImagePreviewOpen
        || isMultiRunLauncherOpen
        || isSessionSwitcherOpen
        || isSettingsDialogOpen;
};

type HydratingToolSkeletonRow = {
    id: string;
    titleWidth: string;
    detailWidth: string;
};

type ChatViewportProps = {
    currentSessionId: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    stickyUserHeader: boolean;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    turnStart: number;
    pendingRevealWork: boolean;
    renderedMessages: SessionMessageRecord[];
    hasMoreAboveTurns: boolean;
    isLoadingOlder: boolean;
    sessionIsWorking: boolean;
    streamingMessageId: string | null;
    activeStreamingPhase: import('./message/types').StreamPhase | null;
    retryOverlay: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    handleMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    handleLoadOlder: () => void;
    scrollToBottom: (options?: { instant?: boolean; force?: boolean }) => void;
    sessionQuestions: QuestionRequest[];
    sessionPermissions: PermissionRequest[];
    isProgrammaticFollowActive: boolean;
};

const ChatViewport = React.memo(({
    currentSessionId,
    isDesktopExpandedInput,
    isMobile,
    stickyUserHeader,
    scrollRef,
    messageListRef,
    turnStart,
    pendingRevealWork,
    renderedMessages,
    hasMoreAboveTurns,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    handleMessageContentChange,
    getAnimationHandlers,
    handleLoadOlder,
    scrollToBottom,
    sessionQuestions,
    sessionPermissions,
    isProgrammaticFollowActive,
}: ChatViewportProps) => {
    const focusScrollContainer = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
            return;
        }

        scrollRef.current?.focus({ preventScroll: true });
    }, [scrollRef]);

    return (
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
                    style={CHAT_SCROLL_STYLE}
                    observeMutations={false}
                    hideTopShadow={isMobile && stickyUserHeader}
                    tabIndex={0}
                    onClick={focusScrollContainer}
                    data-scroll-shadow="true"
                    data-scrollbar="chat"
                >
                    <div className="relative z-0 min-h-full">
                        <MessageList
                            ref={messageListRef}
                            sessionKey={currentSessionId}
                            turnStart={turnStart}
                            disableStaging={pendingRevealWork}
                            messages={renderedMessages}
                            sessionIsWorking={sessionIsWorking}
                            activeStreamingMessageId={streamingMessageId}
                            activeStreamingPhase={activeStreamingPhase}
                            retryOverlay={retryOverlay}
                            onMessageContentChange={handleMessageContentChange}
                            getAnimationHandlers={getAnimationHandlers}
                            hasMoreAbove={hasMoreAboveTurns}
                            isLoadingOlder={isLoadingOlder}
                            onLoadOlder={handleLoadOlder}
                            scrollToBottom={scrollToBottom}
                            scrollRef={scrollRef}
                        />
                        {(sessionQuestions.length > 0 || sessionPermissions.length > 0) && (
                            <div>
                                {sessionQuestions.map((question) => (
                                    <QuestionCard key={question.id} question={question} />
                                ))}
                                {sessionPermissions.map((permission) => (
                                    <PermissionCard key={permission.id} permission={permission} />
                                ))}
                            </div>
                        )}

                        <div className="mb-3">
                            <StatusRowContainer />
                        </div>

                        <div className="flex-shrink-0" style={{ height: isMobile ? '40px' : '10vh' }} aria-hidden="true" />
                    </div>
                </ScrollShadow>
                <OverlayScrollbar containerRef={scrollRef} suppressVisibility={isProgrammaticFollowActive} userIntentOnly observeMutations={false} />
            </div>
        </div>
    );
}, (prev, next) => {
    return prev.currentSessionId === next.currentSessionId
        && prev.isDesktopExpandedInput === next.isDesktopExpandedInput
        && prev.isMobile === next.isMobile
        && prev.stickyUserHeader === next.stickyUserHeader
        && prev.scrollRef === next.scrollRef
        && prev.messageListRef === next.messageListRef
        && prev.turnStart === next.turnStart
        && prev.pendingRevealWork === next.pendingRevealWork
        && prev.renderedMessages === next.renderedMessages
        && prev.hasMoreAboveTurns === next.hasMoreAboveTurns
        && prev.isLoadingOlder === next.isLoadingOlder
        && prev.sessionIsWorking === next.sessionIsWorking
        && prev.streamingMessageId === next.streamingMessageId
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.retryOverlay === next.retryOverlay
        && prev.handleMessageContentChange === next.handleMessageContentChange
        && prev.getAnimationHandlers === next.getAnimationHandlers
        && prev.handleLoadOlder === next.handleLoadOlder
        && prev.scrollToBottom === next.scrollToBottom
        && prev.sessionQuestions === next.sessionQuestions
        && prev.sessionPermissions === next.sessionPermissions
        && prev.isProgrammaticFollowActive === next.isProgrammaticFollowActive;
});

ChatViewport.displayName = 'ChatViewport';

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
    const { t } = useI18n();
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
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);

    // Streaming state
    const streamingMessageId = useStreamingStore(
        React.useCallback(
            (s) => (currentSessionId ? s.streamingMessageIds.get(currentSessionId) ?? null : null),
            [currentSessionId],
        ),
    );
    const activeStreamingPhase = useStreamingStore(
        React.useCallback(
            (s) => {
                if (!streamingMessageId) return null;
                return s.messageStreamStates.get(streamingMessageId)?.phase ?? null;
            },
            [streamingMessageId],
        ),
    );
    const sessionMessageCount = useSessionMessageCount(currentSessionId ?? '');
    const hasLoadedSessionMessages = useDirectorySync(
        React.useCallback(
            (state) => (currentSessionId ? state.message[currentSessionId] !== undefined : false),
            [currentSessionId],
        ),
    );
    // Messages from sync system
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '');
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;

    // Sessions from sync system
    const sessions = useSessions();

    // Plan detection - watches messages for plan creation and signals store
    usePlanDetection(currentSessionId ?? '');

    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '') ?? IDLE_SESSION_STATUS;

    // Permissions & questions from sync system
    const allPermissions = useDirectorySync(
        React.useCallback((s) => s.permission ?? EMPTY_OBJECT, []),
    );
    const allQuestions = useDirectorySync(
        React.useCallback((s) => s.question ?? EMPTY_OBJECT, []),
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
        if (scopedSessionIds.length === 0) return EMPTY_PERMISSION_REQUESTS;
        return flattenBlockingRequests(permissionsMap, scopedSessionIds);
    }, [permissionsMap, scopedSessionIds]);

    const sessionQuestions = React.useMemo(() => {
        if (scopedSessionIds.length === 0) return EMPTY_QUESTION_REQUESTS;
        return flattenBlockingRequests(questionsMap, scopedSessionIds);
    }, [questionsMap, scopedSessionIds]);
    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
        }

        if (streamingMessageId || activeStreamingPhase) {
            return true;
        }

        const statusType = sessionStatusForCurrent.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }

        const lastMessage = sessionMessages[sessionMessages.length - 1]?.info as Message | undefined;
        return Boolean(
            lastMessage
            && lastMessage.role === 'assistant'
            && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
        );
    }, [activeStreamingPhase, currentSessionId, sessionMessages, sessionPermissions.length, sessionQuestions.length, sessionStatusForCurrent.type, streamingMessageId]);
    const activeRetryStatus = React.useMemo(() => {
        if (!currentSessionId || sessionStatusForCurrent.type !== 'retry') {
            return null;
        }

        const rawMessage = typeof (sessionStatusForCurrent as { message?: string }).message === 'string'
            ? (((sessionStatusForCurrent as { message?: string }).message) ?? '').trim()
            : '';

        return {
            sessionId: currentSessionId,
            message: rawMessage || DEFAULT_RETRY_MESSAGE,
            confirmedAt: (sessionStatusForCurrent as { confirmedAt?: number }).confirmedAt,
        };
    }, [currentSessionId, sessionStatusForCurrent]);
    const [retryFallbackTimestamp, setRetryFallbackTimestamp] = React.useState<number>(0);
    const retryFallbackSessionRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!activeRetryStatus || typeof activeRetryStatus.confirmedAt === 'number') {
            retryFallbackSessionRef.current = null;
            setRetryFallbackTimestamp(0);
            return;
        }

        if (retryFallbackSessionRef.current !== activeRetryStatus.sessionId) {
            retryFallbackSessionRef.current = activeRetryStatus.sessionId;
            setRetryFallbackTimestamp(Date.now());
        }
    }, [activeRetryStatus]);

    const retryOverlay = React.useMemo(() => {
        if (!activeRetryStatus) {
            return null;
        }

        return {
            ...activeRetryStatus,
            fallbackTimestamp: retryFallbackTimestamp,
        };
    }, [activeRetryStatus, retryFallbackTimestamp]);

    // History metadata — use sync's hasMore/isLoading
    const historyMeta = React.useMemo(() => {
        if (!currentSessionId) return null;
        return {
            limit: sessionMessages.length,
            complete: !sync.hasMore(currentSessionId),
            loading: sync.isLoading(currentSessionId),
        };
    }, [currentSessionId, sessionMessages.length, sync]);

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
        const parentDirectory = (parentSession as Session & { directory?: string | null }).directory ?? null;
        setCurrentSession(parentSession.id, parentDirectory);
    }, [parentSession, setCurrentSession]);

    const returnToParentButton = parentSession ? (
        <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleReturnToParentSession}
            className="absolute left-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95"
            aria-label={t('chat.container.returnToParent.aria')}
            title={parentSession.title?.trim()
                ? t('chat.container.returnToParent.titleNamed', { title: parentSession.title })
                : t('chat.container.returnToParent.title')}
        >
            <RiArrowLeftLine className="h-4 w-4" />
            {t('chat.container.returnToParent.label')}
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
        prepareForBottomResume,
        scrollToBottom,
        isPinned,
        isOverflowing,
        isProgrammaticFollowActive,
    } = useChatScrollManager({
        currentSessionId,
        sessionMessageCount,
        sessionIsWorking,
        sessionMemoryState: sessionMemoryStateMap,
        updateViewportAnchor,
        isSyncing,
        isMobile,
        chatRenderMode,
        sessionPermissions: sessionBlockingCards,
        onActiveTurnChange: handleActiveTurnChange,
    });

    const viewportMessages = sessionMessages;

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        messages: viewportMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        prepareForBottomResume,
        scrollToBottom,
        isPinned,
        isOverflowing,
    });
    const { loadEarlier, resumeToBottomInstant } = timelineController;

    const runLatestInstantResume = React.useCallback(async () => {
        if (!currentSessionId) {
            scrollToBottom({ instant: true, force: true });
            return;
        }
        await resumeToBottomInstant();
    }, [currentSessionId, resumeToBottomInstant, scrollToBottom]);

    const resumeToLatestInstant = React.useCallback(() => {
        void runLatestInstantResume();
    }, [runLatestInstantResume]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [timelineController.handleActiveTurnChange]);

    React.useEffect(() => {
        if (sessionPermissions.length === 0 && sessionQuestions.length === 0) {
            return;
        }
        handleMessageContentChange('permission');
    }, [handleMessageContentChange, sessionPermissions, sessionQuestions]);

    const handleLoadOlder = React.useCallback(() => {
        void loadEarlier();
    }, [loadEarlier]);

    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottomInstant,
    });

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId || isDesktopExpandedInput) {
            return;
        }

        const handleChatTurnKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) {
                return;
            }

            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
                return;
            }

            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }

            const { activeMainTab } = useUIStore.getState();
            if (activeMainTab !== 'chat' || hasBlockingChatOverlay()) {
                return;
            }

            const scrollContainer = scrollRef.current;
            if (shouldIgnoreChatNavigationForFocus(document.activeElement, scrollContainer)) {
                return;
            }

            if (shouldIgnoreChatNavigationTarget(event.target)) {
                return;
            }

            event.preventDefault();
            const offset = event.key === 'ArrowUp' ? -1 : 1;
            void navigation.scrollByTurnOffset(offset, { resumePastEnd: false });
        };

        window.addEventListener('keydown', handleChatTurnKeyDown);
        return () => {
            window.removeEventListener('keydown', handleChatTurnKeyDown);
        };
    }, [currentSessionId, isDesktopExpandedInput, navigation, scrollRef]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId) return;

        const handleSessionReselected = (event: Event) => {
            const customEvent = event as CustomEvent<string>;
            if (customEvent.detail !== currentSessionId) return;
            if (isPinned || !isOverflowing || isProgrammaticFollowActive) return;
            void resumeToBottomInstant();
        };

        window.addEventListener(SESSION_RESELECTED_EVENT, handleSessionReselected as EventListener);
        return () => {
            window.removeEventListener(SESSION_RESELECTED_EVENT, handleSessionReselected as EventListener);
        };
    }, [currentSessionId, isOverflowing, isPinned, isProgrammaticFollowActive, resumeToBottomInstant]);

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

    const lastScrolledSessionRef = React.useRef<string | null>(null);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasLoadedSessionMessages;

    React.useEffect(() => {
        if (!currentSessionId) {
            return;
        }

        if (lastScrolledSessionRef.current === currentSessionId) {
            return;
        }

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        if (hasHashTarget) {
            lastScrolledSessionRef.current = currentSessionId;
            return;
        }

        lastScrolledSessionRef.current = currentSessionId;

        if (typeof window === 'undefined') {
            resumeToLatestInstant();
            return;
        }

        window.requestAnimationFrame(() => {
            resumeToLatestInstant();
        });
    }, [currentSessionId, resumeToLatestInstant]);

    React.useEffect(() => {
        if (!currentSessionId) return;
        if (hasLoadedSessionMessages) return;

        const load = async () => {
            await loadMessages(currentSessionId).finally(() => {
                const statusType = sessionStatusForCurrent.type ?? 'idle';
                const isActivePhase = statusType === 'busy' || statusType === 'retry';
                const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
                const shouldSkipScroll = hasHashTarget || (isActivePhase && isPinned);

                if (!shouldSkipScroll) {
                    if (typeof window === 'undefined') {
                        resumeToLatestInstant();
                    } else {
                        window.requestAnimationFrame(() => {
                            resumeToLatestInstant();
                        });
                    }
                }
            });
        };

        void load();
    }, [currentSessionId, hasLoadedSessionMessages, isPinned, loadMessages, resumeToLatestInstant, sessionStatusForCurrent.type]);

	if (!currentSessionId && !draftOpen) {
		return (
			<div className="flex flex-col h-full bg-background">
				<ChatEmptyState />
			</div>
		);
	}

	if (!currentSessionId && draftOpen) {
		return (
			<div className="relative flex flex-col h-full bg-background transform-gpu">
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
							: 'bg-background'
					)}
				>
						<ChatInput scrollToBottom={resumeToLatestInstant} />
				</div>
			</div>
        );
    }

    if (!currentSessionId) {
        return null;
    }

	if (isSessionHydrating && sessionMessages.length === 0 && !streamingMessageId) {
		return (
			<div className="relative flex flex-col h-full bg-background">
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
                    <div className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background pt-6" style={CHAT_SCROLL_STYLE}>
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
							: 'bg-background'
					)}
				>
					<ChatInput scrollToBottom={resumeToLatestInstant} />
				</div>
            </div>
        );
    }

	if (sessionMessages.length === 0 && !streamingMessageId) {
		return (
			<div className="relative flex flex-col h-full bg-background transform-gpu">
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
							: 'bg-background'
					)}
				>
					<ChatInput scrollToBottom={resumeToLatestInstant} />
				</div>
            </div>
        );
    }

	return (
		<div className="relative flex flex-col h-full bg-background">
			{returnToParentButton}
			<ChatViewport
				currentSessionId={currentSessionId}
                isDesktopExpandedInput={isDesktopExpandedInput}
                isMobile={isMobile}
                stickyUserHeader={stickyUserHeader}
                scrollRef={scrollRef}
                messageListRef={messageListRef}
                turnStart={timelineController.turnStart}
                pendingRevealWork={timelineController.pendingRevealWork}
                renderedMessages={timelineController.renderedMessages}
                hasMoreAboveTurns={timelineController.historySignals.hasMoreAboveTurns}
                isLoadingOlder={timelineController.isLoadingOlder}
                sessionIsWorking={sessionIsWorking}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                handleMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                handleLoadOlder={handleLoadOlder}
                scrollToBottom={scrollToBottom}
                sessionQuestions={sessionQuestions}
                sessionPermissions={sessionPermissions}
                isProgrammaticFollowActive={isProgrammaticFollowActive}
            />

            <div
                className={cn(
                    'relative z-10',
					isDesktopExpandedInput
						? 'flex-1 min-h-0 bg-background'
						: 'bg-background'
				)}
			>
				{!isDesktopExpandedInput && sessionMessages.length > 0 && (
					<ScrollToBottomButton
                        visible={timelineController.showScrollToBottom}
                        onClick={navigation.resumeToLatest}
                    />
                )}
                <ChatInput scrollToBottom={resumeToLatestInstant} />
            </div>
        </div>
    );
};
