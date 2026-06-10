import React from 'react';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2';

import { ChatInput } from './ChatInput';
import { DraftPresetChips } from './DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import MessageList, { type MessageListHandle } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { StatusRowContainer } from './StatusRowContainer';
import ScrollToTopButton from './components/ScrollToTopButton';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useChatAutoFollow, type AnimationHandlers, type ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { TimelineDialog } from './TimelineDialog';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { smoothWheelScrollElement } from '@/components/ui/smoothWheelScroll';
import { Icon } from "@/components/icon/Icon";
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import {
    collectVisibleSessionIdsForBlockingRequests,
    flattenBlockingRequests,
} from './lib/blockingRequests';

// New sync system imports
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useSessionMessageCount,
    useSessionMessageRecords,
    useSessions,
    useDirectorySync,
    useSyncDirectory,
    useSessionStatus,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { getSessionPrefetch, subscribeSessionPrefetch } from '@/sync/session-prefetch-cache';
import { getSessionMaterializationStatus } from '@/sync/materialization';
import { usePlanDetection } from '@/hooks/usePlanDetection';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };
const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'openchamber:chat-force-scroll-bottom';
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

const shouldLetChatInputOwnWheel = (target: EventTarget | null): boolean => {
    if (!isHTMLElement(target)) {
        return false;
    }

    return Boolean(target.closest('[data-chat-input-box="true"], [data-radix-popper-content-wrapper], [role="listbox"], [role="menu"]'));
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
    pendingRevealWork: boolean;
    renderedMessages: SessionMessageRecord[];
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
    handleHistoryScroll: () => void;
    scrollToBottom: () => void;
    sessionQuestions: QuestionRequest[];
    sessionPermissions: PermissionRequest[];
};

const ChatViewport = React.memo(({
    currentSessionId,
    isDesktopExpandedInput,
    isMobile,
    stickyUserHeader,
    scrollRef,
    messageListRef,
    pendingRevealWork,
    renderedMessages,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    handleMessageContentChange,
    getAnimationHandlers,
    handleHistoryScroll,
    scrollToBottom,
    sessionQuestions,
    sessionPermissions,
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
                    onScroll={handleHistoryScroll}
                    data-scroll-shadow="true"
                    data-scrollbar="chat"
                >
                    <div className="relative z-0 min-h-full">
                        <MessageList
                            ref={messageListRef}
                            sessionKey={currentSessionId}
                            disableStaging={pendingRevealWork}
                            messages={renderedMessages}
                            sessionIsWorking={sessionIsWorking}
                            activeStreamingMessageId={streamingMessageId}
                            activeStreamingPhase={activeStreamingPhase}
                            retryOverlay={retryOverlay}
                            onMessageContentChange={handleMessageContentChange}
                            getAnimationHandlers={getAnimationHandlers}
                            isLoadingOlder={isLoadingOlder}
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
        && prev.pendingRevealWork === next.pendingRevealWork
        && prev.renderedMessages === next.renderedMessages
        && prev.isLoadingOlder === next.isLoadingOlder
        && prev.sessionIsWorking === next.sessionIsWorking
        && prev.streamingMessageId === next.streamingMessageId
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.retryOverlay === next.retryOverlay
        && prev.handleMessageContentChange === next.handleMessageContentChange
        && prev.getAnimationHandlers === next.getAnimationHandlers
        && prev.handleHistoryScroll === next.handleHistoryScroll
        && prev.scrollToBottom === next.scrollToBottom
        && prev.sessionQuestions === next.sessionQuestions
        && prev.sessionPermissions === next.sessionPermissions;
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

const ReadOnlyPromptBanner: React.FC = () => {
    const { t } = useI18n();

    return (
        <div className="p-3">
            <div className="rounded-2xl border border-border/70 bg-[var(--surface-background)] px-4 py-3 typography-ui-label text-muted-foreground">
                {t('chat.container.readOnlySubagentPromptBanner')}
            </div>
        </div>
    );
};

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    const label = project.label?.trim();
    return label || formatDirectoryName(project.path);
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

type ChatContainerProps = {
    autoOpenDraft?: boolean;
    readOnly?: boolean;
};

export const ChatContainer: React.FC<ChatContainerProps> = ({ autoOpenDraft = true, readOnly = false }) => {
    const { t } = useI18n();
    // Session UI state
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((s) => s.currentSessionDirectory);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const projects = useProjectsStore((s) => s.projects);
    const activeProjectId = useProjectsStore((s) => s.activeProjectId);

    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    const ensureSessionRenderable = React.useCallback(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId),
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
    const isTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);

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
    const sessionMessageCount = useSessionMessageCount(currentSessionId ?? '', effectiveSessionDirectory);
    const hasRenderableSessionSnapshot = useDirectorySync(
        React.useCallback(
            (state) => (currentSessionId ? getSessionMaterializationStatus(state, currentSessionId).renderable : false),
            [currentSessionId],
        ),
        effectiveSessionDirectory,
    );
    // Messages from sync system
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;
    const sessionPrefetchInfo = React.useSyncExternalStore(
        React.useCallback(
            (notify) => currentSessionId
                ? subscribeSessionPrefetch(effectiveSessionDirectory, currentSessionId, notify)
                : () => undefined,
            [currentSessionId, effectiveSessionDirectory],
        ),
        React.useCallback(
            () => currentSessionId ? getSessionPrefetch(effectiveSessionDirectory, currentSessionId) : undefined,
            [currentSessionId, effectiveSessionDirectory],
        ),
        React.useCallback(() => undefined, []),
    );

    // Sessions from sync system
    const sessions = useSessions(effectiveSessionDirectory);

    // Plan detection - watches messages for plan creation and signals store
    usePlanDetection(currentSessionId ?? '', sessionMessages);

    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory) ?? IDLE_SESSION_STATUS;

    // Permissions & questions from sync system
    const allPermissions = useDirectorySync(
        React.useCallback((s) => s.permission ?? {}, []),
        effectiveSessionDirectory,
    );
    const allQuestions = useDirectorySync(
        React.useCallback((s) => s.question ?? {}, []),
        effectiveSessionDirectory,
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
    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
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
    }, [currentSessionId, sessionMessages, sessionPermissions.length, sessionQuestions.length, sessionStatusForCurrent.type]);
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
        const prefetchHasMore = Boolean(sessionPrefetchInfo?.cursor) && sessionPrefetchInfo?.complete !== true;
        return {
            limit: sessionMessages.length,
            complete: !(sync.hasMore(currentSessionId) || prefetchHasMore),
            loading: sync.isLoading(currentSessionId),
        };
    }, [currentSessionId, sessionMessages.length, sessionPrefetchInfo, sync]);

    const { isMobile } = useDeviceInfo();
    const isVSCode = isVSCodeRuntime();
    const chatSurfaceMode = useChatSurfaceMode();
    const draftOpen = Boolean(newSessionDraft?.open);
    const initError = useGlobalSyncStore((s) => s.error);
    const isDesktopExpandedInput = isExpandedInput && !isMobile;
    const useCompactDraftLayout = isMobile || isVSCode || chatSurfaceMode === 'mini-chat';
    const messageListRef = React.useRef<MessageListHandle | null>(null);
    const draftProjectLabel = React.useMemo(() => {
        const selectedProject = newSessionDraft?.selectedProjectId
            ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
            : null;
        const activeProject = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        const project = selectedProject ?? activeProject ?? projects[0] ?? null;
        return project ? getProjectDisplayLabel(project) : null;
    }, [activeProjectId, newSessionDraft?.selectedProjectId, projects]);

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
            <Icon name="arrow-left" className="h-4 w-4" />
            {t('chat.container.returnToParent.label')}
        </Button>
    ) : null;
    const promptReadOnly = readOnly || Boolean(parentSession);

    React.useEffect(() => {
        if (autoOpenDraft && !currentSessionId && !draftOpen) {
            openNewSessionDraft();
        }
    }, [autoOpenDraft, currentSessionId, draftOpen, openNewSessionDraft]);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);

    const {
        scrollRef,
        notifyContentChange: handleMessageContentChange,
        getAnimationHandlers,
        goToBottom,
        releaseAutoFollow,
        restoreSnapshot,
        isPinned,
        isFollowingProgrammatically,
        isScrollToBottomAnimating,
        showScrollButton,
    } = useChatAutoFollow({
        currentSessionId,
        sessionMessageCount,
        sessionIsWorking,
        isMobile,
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
        goToBottom,
        releaseAutoFollow,
        isPinned,
        showScrollButton,
    });
    const resumeToLatestInstant = React.useCallback(() => {
        goToBottom('instant');
    }, [goToBottom]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [timelineController.handleActiveTurnChange]);

    React.useEffect(() => {
        if (sessionPermissions.length === 0 && sessionQuestions.length === 0) {
            return;
        }
        handleMessageContentChange('permission');
    }, [handleMessageContentChange, sessionPermissions, sessionQuestions]);

    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottom,
    });
    const { scrollToMessageId: navScrollToMessageId } = navigation;

    const handleHistoryScroll = timelineController.handleHistoryScroll;

    const jumpScrollActiveRef = React.useRef(false);
    const [isJumpScrollActive, setIsJumpScrollActive] = React.useState(false);
    const jumpNavigationBusyRef = React.useRef(false);
    const [isJumpNavigationBusy, setIsJumpNavigationBusy] = React.useState(false);
    const jumpScrollGuardRef = React.useRef<{ clear: () => void } | null>(null);
    const jumpNavigationStateRef = React.useRef({
        activeTurnId: timelineController.activeTurnId,
        turnIds: timelineController.turnIds,
        canLoadEarlier: timelineController.historySignals.canLoadEarlier,
    });

    const finishJumpNavigation = React.useCallback(() => {
        jumpNavigationBusyRef.current = false;
        setIsJumpNavigationBusy(false);
    }, []);

    const clearJumpScrollGuard = React.useCallback((resetBusy = true) => {
        const guard = jumpScrollGuardRef.current;
        jumpScrollGuardRef.current = null;
        jumpScrollActiveRef.current = false;
        setIsJumpScrollActive(false);
        guard?.clear();
        if (resetBusy) {
            finishJumpNavigation();
        }
    }, [finishJumpNavigation]);

    const beginJumpScrollGuard = React.useCallback(() => {
        clearJumpScrollGuard(false);
        jumpScrollActiveRef.current = true;
        setIsJumpScrollActive(true);

        if (typeof window === 'undefined') {
            return;
        }

        const container = scrollRef.current;
        let timeoutId: number | null = null;
        const clear = () => {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            container?.removeEventListener('scrollend', finish);
        };
        const finish = () => {
            if (jumpScrollGuardRef.current?.clear !== clear) {
                return;
            }
            jumpScrollGuardRef.current = null;
            jumpScrollActiveRef.current = false;
            setIsJumpScrollActive(false);
            clear();

            // After the jump scroll finishes, check if we are near the top boundary
            // and allow the history load handler to proceed.
            if (container) {
                const HISTORY_SCROLL_THRESHOLD = 200;
                if (container.scrollTop < HISTORY_SCROLL_THRESHOLD) {
                    handleHistoryScroll();
                }
            }

            finishJumpNavigation();
        };

        container?.addEventListener('scrollend', finish, { once: true });
        // Backup safety timeout for browsers lacking native 'scrollend' support 
        // (e.g. older Safari/Chrome/Firefox or when scroll is interrupted by user).
        timeoutId = window.setTimeout(finish, 3000);
        jumpScrollGuardRef.current = { clear };
    }, [clearJumpScrollGuard, finishJumpNavigation, handleHistoryScroll, scrollRef]);

    React.useEffect(() => clearJumpScrollGuard, [clearJumpScrollGuard, currentSessionId]);

    const isTurnUserMessageAboveViewport = React.useCallback((turnId: string | null) => {
        if (!turnId) {
            return false;
        }

        const container = scrollRef.current;
        if (!container) {
            return false;
        }

        const messageElement = container.querySelector<HTMLElement>(`[data-message-id="${turnId}"]`);
        if (!messageElement) {
            return false;
        }

        const containerTop = container.getBoundingClientRect().top;
        const messageBottom = messageElement.getBoundingClientRect().bottom;
        return messageBottom <= containerTop + 1;
    }, [scrollRef]);
    const [activeUserMessageAboveJumpTarget, setActiveUserMessageAboveJumpTarget] = React.useState(false);
    const updateActiveUserMessageJumpState = React.useCallback(() => {
        setActiveUserMessageAboveJumpTarget(isTurnUserMessageAboveViewport(timelineController.activeTurnId));
    }, [isTurnUserMessageAboveViewport, timelineController.activeTurnId]);
    const handleChatHistoryScroll = React.useCallback(() => {
        if (!jumpScrollActiveRef.current) {
            handleHistoryScroll();
        }
        updateActiveUserMessageJumpState();
    }, [handleHistoryScroll, updateActiveUserMessageJumpState]);

    React.useLayoutEffect(() => {
        jumpNavigationStateRef.current = {
            activeTurnId: timelineController.activeTurnId,
            turnIds: timelineController.turnIds,
            canLoadEarlier: timelineController.historySignals.canLoadEarlier,
        };
    }, [timelineController.activeTurnId, timelineController.historySignals.canLoadEarlier, timelineController.turnIds]);

    React.useLayoutEffect(() => {
        updateActiveUserMessageJumpState();
    }, [timelineController.renderedMessages, timelineController.activeTurnId, updateActiveUserMessageJumpState]);

    const activeTurnIndex = timelineController.activeTurnId
        ? timelineController.turnIds.indexOf(timelineController.activeTurnId)
        : -1;
    const showJumpToPreviousMessage = timelineController.turnIds.length > 0
        && (activeTurnIndex !== 0 || activeUserMessageAboveJumpTarget)
        && (!timelineController.pendingRevealWork || isJumpNavigationBusy);

    const getJumpTarget = React.useCallback(() => {
        const state = jumpNavigationStateRef.current;
        const { turnIds, activeTurnId } = state;

        if (turnIds.length === 0) {
            return { targetId: null };
        }

        if (!activeTurnId) {
            return { targetId: turnIds[turnIds.length - 1] ?? null };
        }

        const currentIndex = turnIds.indexOf(activeTurnId);

        if (currentIndex >= 0 && isTurnUserMessageAboveViewport(activeTurnId)) {
            return { targetId: activeTurnId };
        }

        if (currentIndex > 0) {
            return { targetId: turnIds[currentIndex - 1] ?? null };
        }

        return { targetId: null };
    }, [isTurnUserMessageAboveViewport]);

    const handleJumpToPreviousMessage = React.useCallback(async () => {
        if (jumpNavigationBusyRef.current) {
            return;
        }

        const target = getJumpTarget();
        if (!target.targetId) {
            return;
        }

        jumpNavigationBusyRef.current = true;
        setIsJumpNavigationBusy(true);
        beginJumpScrollGuard();

        try {
            const scrolled = await navScrollToMessageId(target.targetId, { behavior: 'smooth' });
            if (!scrolled) {
                clearJumpScrollGuard();
            }
        } catch {
            clearJumpScrollGuard();
        }
    }, [beginJumpScrollGuard, clearJumpScrollGuard, getJumpTarget, navScrollToMessageId]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId) return;

        const handleForceScrollBottom = (event: Event) => {
            const customEvent = event as CustomEvent<{ sessionId?: string }>;
            if (customEvent.detail?.sessionId && customEvent.detail.sessionId !== currentSessionId) return;
            goToBottom('instant');
        };

        window.addEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        return () => {
            window.removeEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        };
    }, [currentSessionId, goToBottom]);

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
        && !hasRenderableSessionSnapshot;

    React.useEffect(() => {
        if (!currentSessionId) return;
        if (lastScrolledSessionRef.current === currentSessionId) return;

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionRef.current = currentSessionId;
        if (hasHashTarget) {
            // Hash navigation handler will scroll to target; we just release auto-follow.
            releaseAutoFollow();
            return;
        }

        const run = () => {
            void restoreSnapshot();
        };
        if (typeof window === 'undefined') {
            run();
        } else {
            window.requestAnimationFrame(run);
        }
    }, [currentSessionId, releaseAutoFollow, restoreSnapshot]);

    React.useEffect(() => {
        if (!currentSessionId) return;
        if (hasRenderableSessionSnapshot) return;
        if (effectiveSessionDirectory !== syncDirectory) return;
        void ensureSessionRenderable(currentSessionId);
    }, [currentSessionId, effectiveSessionDirectory, ensureSessionRenderable, hasRenderableSessionSnapshot, syncDirectory]);

    const handleNavigationWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        if (isDesktopExpandedInput) {
            return;
        }

        if (event.defaultPrevented || shouldLetChatInputOwnWheel(event.target)) {
            return;
        }

        const scrollContainer = scrollRef.current;
        if (!scrollContainer) {
            return;
        }

        if (event.deltaY === 0) {
            return;
        }

        event.preventDefault();
        smoothWheelScrollElement(scrollContainer, event);
    }, [isDesktopExpandedInput, scrollRef]);

	if (!currentSessionId && !draftOpen) {
		// With auto-open, the draft welcome opens on the next tick (effect below),
		// so the empty state is only ever transient here — render a neutral
		// background instead of flashing the logo / "start a new chat" on refresh.
		// Keep the empty state when there's nothing to auto-open or an init error to show.
		if (autoOpenDraft && !initError) {
			return <div className="flex h-full flex-col bg-background" />;
		}
		return (
			<div className="flex flex-col h-full bg-background">
				<ChatEmptyState />
			</div>
		);
	}

	if (!currentSessionId && draftOpen) {
		return (
			<div className="relative flex h-full flex-col bg-background transform-gpu">
				{useCompactDraftLayout && !isDesktopExpandedInput ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
						<h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
							{renderDraftTitle(
								draftProjectLabel
									? t('chat.emptyState.draftTitleWithProject', { project: draftProjectLabel })
									: t('chat.emptyState.draftTitle'),
								draftProjectLabel,
							)}
						</h1>
						<DraftPresetChips
							onSubmit={(text) => useInputStore.getState().requestPresetSubmit(text)}
							className="mt-8 max-w-md"
						/>
					</div>
				) : null}
				<div
					className={cn(
						'relative z-10 flex min-h-0',
						isDesktopExpandedInput
							? 'flex-1 bg-background'
							: useCompactDraftLayout
								? 'bg-background px-0'
								: 'flex-1 items-center justify-center bg-background px-0 pb-[6vh]'
					)}
				>
						{promptReadOnly ? <ReadOnlyPromptBanner /> : <ChatInput scrollToBottom={resumeToLatestInstant} />}
				</div>
			</div>
        );
    }

    if (!currentSessionId) {
        return null;
    }

	if (isSessionHydrating && sessionMessages.length === 0 && !sessionIsWorking) {
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
					{promptReadOnly ? <ReadOnlyPromptBanner /> : <ChatInput scrollToBottom={resumeToLatestInstant} />}
				</div>
            </div>
        );
    }

	if (sessionMessages.length === 0 && !sessionIsWorking) {
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
					{promptReadOnly ? <ReadOnlyPromptBanner /> : <ChatInput scrollToBottom={resumeToLatestInstant} />}
				</div>
            </div>
        );
    }

	return (
		<div className="relative flex flex-col h-full bg-background">
			{returnToParentButton}
			<ScrollToTopButton
				visible={showJumpToPreviousMessage && !isDesktopExpandedInput}
				onClick={handleJumpToPreviousMessage}
				disabled={isJumpNavigationBusy}
				onWheelCapture={handleNavigationWheel}
			/>
			<ChatViewport
				key={currentSessionId}
				currentSessionId={currentSessionId}
                isDesktopExpandedInput={isDesktopExpandedInput}
                isMobile={isMobile}
                stickyUserHeader={stickyUserHeader}
                scrollRef={scrollRef}
                messageListRef={messageListRef}
                pendingRevealWork={timelineController.pendingRevealWork}
                renderedMessages={timelineController.renderedMessages}
                isLoadingOlder={timelineController.isLoadingOlder}
                sessionIsWorking={sessionIsWorking}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                handleMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                handleHistoryScroll={handleChatHistoryScroll}
                scrollToBottom={resumeToLatestInstant}
                sessionQuestions={sessionQuestions}
                sessionPermissions={sessionPermissions}
            />

            <div
                className={cn(
                    'relative z-10',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : 'bg-background'
                )}
                onWheelCapture={handleNavigationWheel}
            >
                {!isDesktopExpandedInput && sessionMessages.length > 0 && (
                    <ScrollToBottomButton
                        visible={timelineController.showScrollToBottom}
                        onClick={navigation.resumeToLatest}
                        onWheelCapture={handleNavigationWheel}
                    />
                )}
                {promptReadOnly ? <ReadOnlyPromptBanner /> : <ChatInput scrollToBottom={resumeToLatestInstant} />}
            </div>

            <OverlayScrollbar
                containerRef={scrollRef}
                suppressVisibility={isFollowingProgrammatically && !isJumpScrollActive && !isScrollToBottomAnimating}
                userIntentOnly
                forceVisible={isJumpScrollActive || isScrollToBottomAnimating}
                observeMutations={false}
                className="absolute inset-y-0 right-0 z-30"
                style={{ left: 'auto', width: '16px' }}
            />

            <TimelineDialog
                open={isTimelineDialogOpen}
                onOpenChange={setTimelineDialogOpen}
                onScrollToMessage={timelineController.scrollToMessage}
                onScrollByTurnOffset={navigation.scrollByTurnOffset}
                onResumeToLatest={resumeToLatestInstant}
            />
        </div>
    );
};
