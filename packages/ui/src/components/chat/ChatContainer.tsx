import React from 'react';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

import { ChatInput } from './ChatInput';
import { ChatColumnSessionContext, type ChatColumnSession } from './chatColumnSession';
import { DraftPresetChips } from './DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import MessageList, { type MessageListHandle } from './MessageList';
import { createTimelineRevealGate, TIMELINE_REVEAL_CAP_MS, TimelineRevealGateContext, type TimelineRevealGate } from './timelineRevealGate';

// How long the previous timeline stays on screen while a session that is not
// in memory loads, before the skeleton takes over.
const SESSION_SWITCH_HOLD_MS = 400;
// End inset reserved for the status row that floats over the timeline's
// bottom edge (its tallest resting height plus the mb-2 gap).
const STATUS_OVERLAY_RESERVED_HEIGHT = 40;
// A freshly opened timeline is shown once its content height has held still
// for this many consecutive frames, or after the cap.
const TIMELINE_SETTLE_STABLE_FRAMES = 2;
const TIMELINE_SETTLE_CAP_MS = 300;
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { hasActiveQuestionToolInCurrentTurn, recoverPendingQuestionWithRetry } from '@/sync/question-recovery';
import { StatusRowContainer } from './StatusRowContainer';
import { SessionRecapNote } from '@/components/chat/SessionRecapSpacer';
import { SessionErrorNotice } from '@/components/chat/SessionErrorNotice';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { PromptNavigatorRail } from './components/PromptNavigatorRail';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useScrollShadow } from '@/components/ui/useScrollShadow';
import { useChatTimelineScroll, type TimelineListHandle } from '@/hooks/useChatTimelineScroll';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { TimelineDialog } from './TimelineDialog';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from "@/components/icon/Icon";
import { cn, formatDirectoryName } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';

// New sync system imports
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useSessionMessageCount,
    useSessionMessageRecords,
    useSessionMessageLoadState,
    useSyncDirectory,
    useSessionRenderable,
    useSessionStatus,
    useScopedBlockingPermissions,
    useScopedBlockingQuestions,
    useParentSession,
    useSession,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { usePlanDetection } from '@/hooks/usePlanDetection';
import { useI18n } from '@/lib/i18n';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isVSCodeRuntime } from '@/lib/desktop';
import { WorkStatusPanel } from './work-status/WorkStatusPanel';
import { useWorkStatusVisibility } from './work-status/useWorkStatusVisibility';
import { getEmbeddedSessionChatOriginSessionId } from '@/components/layout/contextPanelEmbeddedChat';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { hasContextParts } from '@/lib/messages/contextParts';
import { normalizeUserDisplayParts } from './message/normalizeUserDisplayParts';
import { findShellCommandForMessage, isUserShellMarkerMessage } from './lib/shellBridge';
import { resolveChatPromptReadOnly } from './chatPromptReadOnly';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createFirstVisibleSessionPerformanceTracker } from '@/sync/session-load-performance';
import { isChatDirectoryPath } from '@/lib/chatDirectories';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };
const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'openchamber:chat-force-scroll-bottom';
const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';
const DRAFT_EXIT_DURATION_MS = 120;
const COMPOSER_MOVE_DURATION_MS = 180;
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
    currentSessionKey: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    directory?: string;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    registerList: (list: TimelineListHandle | null) => void;
    anchorMessageId: string | null;
    onAnchorReady: (messageId: string, anchorIndex: number) => void;
    onAnchorSizeChanged: (messageId: string) => void;
    onIsAtEndChange: (isAtEnd: boolean) => void;
    onTimelineDataChange: () => void;
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
    scrollToBottom: () => void;
    endPinningReleased: boolean;
    /** The user waited for this session (held or fetched); reveal it with a fade. */
    revealWaited: boolean;
    revealGate: TimelineRevealGate;
    sessionQuestions: QuestionRequest[];
    sessionPermissions: PermissionRequest[];
    isProgrammaticFollowActive: boolean;
    showLoadOlderButton: boolean;
    onLoadOlder: () => void;
    turnIds: string[];
    activeTurnId: string | null;
    onSelectTurn: (turnId: string) => void;
    showPromptNavigator: boolean;
    canLoadEarlierPrompts: boolean;
    isLoadingOlderPrompts: boolean;
    onLoadEarlierPrompts: () => void;
};

const ChatViewport = React.memo(({
    currentSessionId,
    currentSessionKey,
    isDesktopExpandedInput,
    isMobile,
    directory,
    scrollRef,
    messageListRef,
    registerList,
    anchorMessageId,
    onAnchorReady,
    onAnchorSizeChanged,
    onIsAtEndChange,
    onTimelineDataChange,
    renderedMessages,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    scrollToBottom,
    endPinningReleased,
    revealWaited,
    revealGate,
    sessionQuestions,
    sessionPermissions,
    isProgrammaticFollowActive,
    showLoadOlderButton,
    onLoadOlder,
    turnIds,
    activeTurnId,
    onSelectTurn,
    showPromptNavigator,
    canLoadEarlierPrompts,
    isLoadingOlderPrompts,
    onLoadEarlierPrompts,
}: ChatViewportProps) => {
    const { t } = useI18n();
    const promptPreviewsByTurnIdRef = React.useRef<Map<string, Part[]>>(new Map());
    // Cache normalized parts per source array so unchanged messages keep the
    // same reference and the memo below can bail out to the previous map.
    const normalizedPromptPartsCache = React.useRef(new WeakMap<Part[], Part[]>());
    // Shell-mode prompts show their extracted command; cache by message id so
    // the parts array reference is stable while the command is unchanged.
    const shellPreviewCache = React.useRef(new Map<string, { command: string; parts: Part[] }>());
    const shellPreviewSessionRef = React.useRef(currentSessionId);
    if (shellPreviewSessionRef.current !== currentSessionId) {
        shellPreviewSessionRef.current = currentSessionId;
        shellPreviewCache.current.clear();
    }
    const promptPreviewsByTurnId = React.useMemo(() => {
        const next = new Map<string, Part[]>();
        for (let index = 0; index < renderedMessages.length; index += 1) {
            const message = renderedMessages[index];
            if (message.info.role !== 'user') {
                continue;
            }
            if (isUserShellMarkerMessage(message)) {
                const command = findShellCommandForMessage(renderedMessages, index) ?? '';
                const cached = shellPreviewCache.current.get(message.info.id);
                if (cached && cached.command === command) {
                    next.set(message.info.id, cached.parts);
                } else {
                    const parts = [{ type: 'text', text: command ? `$ ${command}` : '/shell' } as Part];
                    shellPreviewCache.current.set(message.info.id, { command, parts });
                    next.set(message.info.id, parts);
                }
                continue;
            }
            // Other fully synthetic user messages (loop continuations,
            // plan-mode injections) are not prompts the user typed — keep
            // them out of the navigator entirely.
            // Attached context (a quoted message, a terminal selection) is
            // synthetic transport-wise but is a turn the user sent, so a
            // context-only message stays navigable.
            if (isFullySyntheticMessage(message.parts) && !hasContextParts(message.parts)) {
                continue;
            }
            let displayParts = normalizedPromptPartsCache.current.get(message.parts);
            if (!displayParts) {
                displayParts = normalizeUserDisplayParts(message.parts);
                normalizedPromptPartsCache.current.set(message.parts, displayParts);
            }
            if (displayParts.length === 0) {
                continue;
            }
            next.set(message.info.id, displayParts);
        }
        const prev = promptPreviewsByTurnIdRef.current;
        if (prev.size === next.size) {
            let unchanged = true;
            for (const [id, parts] of next) {
                if (prev.get(id) !== parts) {
                    unchanged = false;
                    break;
                }
            }
            if (unchanged) {
                return prev;
            }
        }
        promptPreviewsByTurnIdRef.current = next;
        return next;
    }, [renderedMessages]);
    // Only real (non-synthetic) prompts become rail entries; selection still
    // targets the same turn anchors as the timeline.
    const promptTurnIds = React.useMemo(
        () => turnIds.filter((id) => promptPreviewsByTurnId.has(id)),
        [promptPreviewsByTurnId, turnIds],
    );
    // If the viewport sits in a filtered-out (synthetic) turn, treat the
    // nearest preceding real prompt as active so the rail doesn't jump.
    const railActiveTurnId = React.useMemo(() => {
        if (!activeTurnId || promptPreviewsByTurnId.has(activeTurnId)) {
            return activeTurnId;
        }
        const activeIndex = turnIds.indexOf(activeTurnId);
        for (let index = activeIndex - 1; index >= 0; index -= 1) {
            const turnId = turnIds[index];
            if (promptPreviewsByTurnId.has(turnId)) {
                return turnId;
            }
        }
        return null;
    }, [activeTurnId, promptPreviewsByTurnId, turnIds]);
    const focusScrollContainer = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
            return;
        }

        scrollRef.current?.focus({ preventScroll: true });
    }, [scrollRef]);

    // Everything that used to sit beside the list inside the scroll container
    // now renders as the list's header/footer, so it keeps scrolling with the
    // rows exactly as before.
    const listHeader = React.useMemo(() => (
        showLoadOlderButton ? (
            <div className="flex justify-center pt-3 pb-1">
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={onLoadOlder}
                    disabled={isLoadingOlder}
                >
                    {isLoadingOlder && (
                        <Icon name="loader-4" className="size-4 animate-spin" />
                    )}
                    {t('chat.history.loadOlder')}
                </Button>
            </div>
        ) : null
    ), [isLoadingOlder, onLoadOlder, showLoadOlderButton, t]);

    const listFooter = React.useMemo(() => (
        <>
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

            <SessionErrorNotice sessionId={currentSessionId} directory={directory} />
            <SessionRecapNote sessionId={currentSessionId} directory={directory} isMobile={isMobile} />

            <div className="flex-shrink-0" style={{ height: isMobile ? '40px' : '10vh' }} aria-hidden="true" />
        </>
    ), [currentSessionId, directory, isMobile, sessionPermissions, sessionQuestions]);

    // Opening a session paints the timeline as one finished picture: the root
    // stays invisible while any renderer holds a provisional first paint, then
    // everything appears together. A session the user waited for fades in
    // once as a whole; one that was ready at the click shows in the same
    // frame.
    const timelineRootRef = React.useRef<HTMLDivElement | null>(null);
    const endPinningReleasedRef = React.useRef(endPinningReleased);
    endPinningReleasedRef.current = endPinningReleased;
    // Read through a ref: the effect runs once per gate (per opened session).
    // `revealWaited` flips for the session still on screen the moment another
    // one is selected — before the deferred swap mounts it — and re-running
    // the effect then would hide the outgoing timeline for the frames until
    // the new one arrives.
    const revealWaitedRef = React.useRef(revealWaited);
    revealWaitedRef.current = revealWaited;
    React.useLayoutEffect(() => {
        const root = timelineRootRef.current;
        if (!root) return;
        root.setAttribute('data-timeline-reveal', 'pending');
        let finished = false;
        let timer: number | null = null;
        let frame: number | null = null;
        // Revealed once the geometry has settled: after the last hold the
        // list still lays rows out from its own measurements over a few
        // frames, so the timeline stays hidden — pinned to the end on every
        // frame — until the content height has held still for two frames,
        // then shows already sitting on the end. The settle is bounded so a
        // list that keeps growing (images, late tool output) still appears.
        const reveal = (fade: boolean) => {
            if (finished) return;
            finished = true;
            if (timer !== null) window.clearTimeout(timer);
            const startedAt = performance.now();
            let lastHeight = -1;
            let stableFrames = 0;
            const settle = () => {
                frame = null;
                const node = scrollRef.current;
                let height = -1;
                if (node) {
                    height = node.scrollHeight;
                    if (!endPinningReleasedRef.current) {
                        const end = height - node.clientHeight;
                        if (end - node.scrollTop > 1) node.scrollTop = end;
                    }
                }
                stableFrames = height === lastHeight ? stableFrames + 1 : 0;
                lastHeight = height;
                if (stableFrames < TIMELINE_SETTLE_STABLE_FRAMES && performance.now() - startedAt < TIMELINE_SETTLE_CAP_MS) {
                    frame = window.requestAnimationFrame(settle);
                    return;
                }
                if (fade) root.setAttribute('data-timeline-reveal', 'fading');
                else root.removeAttribute('data-timeline-reveal');
            };
            frame = window.requestAnimationFrame(settle);
        };
        // Holds are taken in layout effects, including those of rows the list
        // mounts in a nested synchronous pass; a microtask runs after all of
        // them and still before the browser paints this commit.
        queueMicrotask(() => {
            if (finished) return;
            revealGate.close();
            if (revealGate.holds === 0) {
                reveal(revealWaitedRef.current);
                return;
            }
            revealGate.onEmpty = () => reveal(true);
            timer = window.setTimeout(() => reveal(true), TIMELINE_REVEAL_CAP_MS);
        });
        return () => {
            finished = true;
            if (timer !== null) window.clearTimeout(timer);
            if (frame !== null) window.cancelAnimationFrame(frame);
            revealGate.onEmpty = null;
        };
    }, [revealGate, scrollRef]);

    const scrollContainerProps = React.useMemo(() => ({
        className: 'absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target',
        style: CHAT_SCROLL_STYLE,
        tabIndex: 0,
        onClick: focusScrollContainer,
        'data-scrollbar': 'chat',
        'data-scroll-shadow': 'true',
        'data-orientation': 'vertical',
    }), [focusScrollContainer]);

    return (
        <div
            className={cn(
                'relative min-h-0',
                isDesktopExpandedInput
                    ? 'absolute inset-0 opacity-0 pointer-events-none'
                    : 'flex-1',
            )}
            ref={timelineRootRef}
            aria-hidden={isDesktopExpandedInput}
        >
            <div className="absolute inset-0">
              <TimelineRevealGateContext.Provider value={revealGate}>
                <MessageList
                    key={currentSessionKey}
                    ref={messageListRef}
                    sessionKey={currentSessionId}
                    messages={renderedMessages}
                    sessionIsWorking={sessionIsWorking}
                    activeStreamingMessageId={streamingMessageId}
                    activeStreamingPhase={activeStreamingPhase}
                    retryOverlay={retryOverlay}
                    isLoadingOlder={isLoadingOlder}
                    scrollToBottom={scrollToBottom}
                    endPinningReleased={endPinningReleased}
                    directory={directory}
                    registerList={registerList}
                    anchorMessageId={anchorMessageId}
                    onAnchorReady={onAnchorReady}
                    onAnchorSizeChanged={onAnchorSizeChanged}
                    // Zero end inset: the footer spacer already reserves the
                    // zone the floating status row covers; adding its height
                    // again produced a double-tall blank band at rest.
                    composerOverlayHeight={0}
                    onIsAtEndChange={onIsAtEndChange}
                    onTimelineDataChange={onTimelineDataChange}
                    listHeader={listHeader}
                    listFooter={listFooter}
                    scrollContainerProps={scrollContainerProps}
                />
              </TimelineRevealGateContext.Provider>
                <OverlayScrollbar containerRef={scrollRef} disableHorizontal suppressVisibility={isProgrammaticFollowActive} userIntentOnly observeMutations={false} />
                {showPromptNavigator && promptTurnIds.length >= 2 ? (
                    <PromptNavigatorRail
                        turnIds={promptTurnIds}
                        previewsByTurnId={promptPreviewsByTurnId}
                        activeTurnId={railActiveTurnId}
                        onSelectTurn={onSelectTurn}
                        canLoadEarlier={canLoadEarlierPrompts}
                        isLoadingOlder={isLoadingOlderPrompts}
                        onLoadEarlier={onLoadEarlierPrompts}
                    />
                ) : null}
            </div>
        </div>
    );
}, (prev, next) => {
    return prev.currentSessionId === next.currentSessionId
        && prev.currentSessionKey === next.currentSessionKey
        && prev.isDesktopExpandedInput === next.isDesktopExpandedInput
        && prev.isMobile === next.isMobile
        && prev.directory === next.directory
        && prev.scrollRef === next.scrollRef
        && prev.messageListRef === next.messageListRef
        && prev.renderedMessages === next.renderedMessages
        && prev.isLoadingOlder === next.isLoadingOlder
        && prev.sessionIsWorking === next.sessionIsWorking
        && prev.streamingMessageId === next.streamingMessageId
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.retryOverlay === next.retryOverlay
        && prev.scrollToBottom === next.scrollToBottom
        && prev.endPinningReleased === next.endPinningReleased
        && prev.revealWaited === next.revealWaited
        && prev.revealGate === next.revealGate
        && prev.sessionQuestions === next.sessionQuestions
        && prev.sessionPermissions === next.sessionPermissions
        && prev.isProgrammaticFollowActive === next.isProgrammaticFollowActive
        && prev.showLoadOlderButton === next.showLoadOlderButton
        && prev.onLoadOlder === next.onLoadOlder
        && prev.turnIds === next.turnIds
        && prev.activeTurnId === next.activeTurnId
        && prev.onSelectTurn === next.onSelectTurn
        && prev.showPromptNavigator === next.showPromptNavigator
        && prev.canLoadEarlierPrompts === next.canLoadEarlierPrompts
        && prev.isLoadingOlderPrompts === next.isLoadingOlderPrompts
        && prev.onLoadEarlierPrompts === next.onLoadEarlierPrompts;
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
        <div className="w-full py-3">
            <div className="chat-input-column">
                <div className="rounded-2xl border border-border/70 bg-[var(--surface-background)] px-4 py-3 text-center typography-ui-label text-muted-foreground">
                    {t('chat.container.readOnlySubagentPromptBanner')}
                </div>
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

const DraftWelcome: React.FC<{ exiting?: boolean }> = ({ exiting = false }) => {
    const { t } = useI18n();
    const draftTarget = useSessionUIStore((state) => state.newSessionDraft.target);
    const selectedProjectId = useSessionUIStore((state) => state.newSessionDraft.selectedProjectId ?? null);
    const projectLabel = useProjectsStore(React.useCallback((state) => {
        if (draftTarget === 'chat') return null;
        const projectId = selectedProjectId ?? state.activeProjectId;
        const project = (projectId
            ? state.projects.find((candidate) => candidate.id === projectId)
            : null) ?? state.projects[0] ?? null;
        return project ? getProjectDisplayLabel(project) : null;
    }, [draftTarget, selectedProjectId]));

    return (
        <div className={cn(
            'oc-draft-center flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
            exiting && 'pointer-events-none opacity-0',
        )}>
            <h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
                {renderDraftTitle(
                    projectLabel
                        ? t('chat.emptyState.draftTitleWithProject', { project: projectLabel })
                        : t('chat.emptyState.draftTitle'),
                    projectLabel,
                )}
            </h1>
            <DraftPresetChips
                onSubmit={(starter) => useInputStore.getState().requestPresetSubmit(starter.submitText, starter.ref.type)}
                className="oc-draft-starters mt-8 max-w-md"
            />
        </div>
    );
};

type ChatContainerProps = {
    active?: boolean;
    /**
     * When set, controls message-history reads and session-message loads
     * independently of `active`. Defaults to `active`. Embedded session-chat
     * panels pass `true` so a delayed/lost visibility handshake cannot hide
     * an already-materialized transcript (leaving only the working-status
     * row — issue #2903).
     */
    messagesEnabled?: boolean;
    autoOpenDraft?: boolean;
    readOnly?: boolean;
    initialAllowPromptingSubagentSessions?: boolean;
};

export const ChatContainer: React.FC<ChatContainerProps> = ({
    active = true,
    messagesEnabled: messagesEnabledProp,
    autoOpenDraft = true,
    readOnly = false,
    initialAllowPromptingSubagentSessions,
}) => {
    const messagesEnabled = messagesEnabledProp ?? active;
    const { t } = useI18n();
    // Session UI state. The selection is published synchronously by the
    // sidebar click, but the chat swaps its content on a deferred copy: the
    // first commit paints the cheap reactions (active row, URL, tab) while the
    // timeline for the new session renders in an interruptible transition
    // behind it. Both fields travel as one value so the key, the message
    // subscription, and the loader target never mix an old directory with a
    // new session id.
    const liveSessionId = useSessionUIStore((s) => s.currentSessionId);
    const liveSessionDirectory = useSessionUIStore((s) => s.currentSessionDirectory);
    const materializedDraftSessionId = useSessionUIStore((s) => s.materializedDraftSessionId);
    const liveSelection = React.useMemo(
        () => ({ sessionId: liveSessionId, directory: liveSessionDirectory }),
        [liveSessionId, liveSessionDirectory],
    );
    // A session whose messages are not in memory yet keeps the previous
    // timeline on screen while they load, instead of flashing a skeleton
    // between two conversations. The hold ends when the session becomes
    // renderable or after SESSION_SWITCH_HOLD_MS, whichever comes first, and
    // never applies when nothing was shown before or when the session was just
    // created from a draft.
    const liveSessionRenderable = useSessionRenderable(liveSessionId ?? '', liveSessionDirectory ?? undefined);
    const shownSelectionRef = React.useRef(liveSelection);
    const [expiredHoldSessionId, setExpiredHoldSessionId] = React.useState<string | null>(null);
    const holdPreviousTimeline = Boolean(liveSessionId)
        && !liveSessionRenderable
        && liveSessionId !== materializedDraftSessionId
        && shownSelectionRef.current.sessionId !== null
        && shownSelectionRef.current.sessionId !== liveSessionId
        && expiredHoldSessionId !== liveSessionId;
    React.useEffect(() => {
        if (!holdPreviousTimeline || !liveSessionId) return;
        const timer = window.setTimeout(() => setExpiredHoldSessionId(liveSessionId), SESSION_SWITCH_HOLD_MS);
        return () => window.clearTimeout(timer);
    }, [holdPreviousTimeline, liveSessionId]);
    // A session the user waited for (not in memory at the click) fades in; one
    // that was ready appears in the same frame. Decided once per selection so
    // a later, warm visit to the same session is instant again.
    const lastLiveSessionIdRef = React.useRef<string | null | undefined>(undefined);
    const waitedSessionIdRef = React.useRef<string | null>(null);
    if (liveSessionId !== lastLiveSessionIdRef.current) {
        lastLiveSessionIdRef.current = liveSessionId;
        waitedSessionIdRef.current = liveSessionId && !liveSessionRenderable ? liveSessionId : null;
    }
    const targetSelection = holdPreviousTimeline ? shownSelectionRef.current : liveSelection;
    const { sessionId: currentSessionId, directory: currentSessionDirectory } = React.useDeferredValue(targetSelection);
    shownSelectionRef.current = { sessionId: currentSessionId, directory: currentSessionDirectory };
    const revealWaited = Boolean(currentSessionId) && currentSessionId === waitedSessionIdRef.current;

    const clearMaterializedDraftSession = useSessionUIStore((s) => s.clearMaterializedDraftSession);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);

    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    const currentSessionKey = currentSessionId
        ? JSON.stringify([getRuntimeKey(), effectiveSessionDirectory, currentSessionId])
        : null;
    // One gate per opened session; the scroll hook holds it until the
    // viewport is pinned to the end so the first visible frame is already
    // at the bottom.
    const revealGateRef = React.useRef<{ key: string | null; gate: TimelineRevealGate } | null>(null);
    if (revealGateRef.current?.key !== currentSessionKey) {
        revealGateRef.current = { key: currentSessionKey, gate: createTimelineRevealGate() };
    }
    const revealGate = revealGateRef.current.gate;
    const chatColumnSession = React.useMemo<ChatColumnSession>(
        () => ({ sessionId: currentSessionId ?? null, directory: currentSessionId ? effectiveSessionDirectory ?? null : null }),
        [currentSessionId, effectiveSessionDirectory],
    );
    const ensureSessionRenderable = React.useCallback(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId, false, effectiveSessionDirectory),
        [effectiveSessionDirectory, sync],
    );
    const loadMoreMessages = React.useCallback(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        (sessionId: string, _direction: 'up' | 'down') => sync.loadMore(sessionId, effectiveSessionDirectory),
        [effectiveSessionDirectory, sync],
    );

    // UI store
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
    const [embeddedAllowPrompting, setEmbeddedAllowPrompting] = React.useState(initialAllowPromptingSubagentSessions);
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
    const hasRenderableSessionSnapshot = useSessionRenderable(currentSessionId ?? '', effectiveSessionDirectory);
    // Messages from sync system. Keep this gated by `messagesEnabled`, not
    // `active`, so embedded panels can show history while the composer stays
    // inactive until the parent confirms visibility.
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory, {
        enabled: messagesEnabled,
        suspendPartUpdates: Boolean(streamingMessageId),
        suspendPartUpdatesForMessageId: streamingMessageId,
    });
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;
    const authSessionExpired = useAuthSessionStore((store) => store.state !== 'ok');
    const wasAuthExpiredRef = React.useRef(false);
    const sessionMessageLoadState = useSessionMessageLoadState(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const [firstVisiblePerformance] = React.useState(createFirstVisibleSessionPerformanceTracker);

    React.useEffect(() => {
        if (!active || !currentSessionKey || !hasRenderableSessionSnapshot || sessionMessages.length === 0) return;
        return firstVisiblePerformance.schedule(currentSessionKey, sessionMessages.length);
    }, [active, currentSessionKey, firstVisiblePerformance, hasRenderableSessionSnapshot, sessionMessages.length]);

    // Plan detection - watches messages for plan creation and signals store
    usePlanDetection(currentSessionId ?? '', sessionMessages);

    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory) ?? IDLE_SESSION_STATUS;

    // Scoped blocking requests — only subscribe to permissions/questions for
    // the current session + descendant subagent sessions, not all sessions in
    // the directory.
    const sessionPermissions = useScopedBlockingPermissions(currentSessionId, effectiveSessionDirectory);
    const sessionQuestions = useScopedBlockingQuestions(currentSessionId, effectiveSessionDirectory);

    const hasUnreconciledQuestionTool = React.useMemo(
        () => !sessionQuestions.some((question) => question.sessionID === currentSessionId)
            && hasActiveQuestionToolInCurrentTurn(sessionMessages),
        [currentSessionId, sessionMessages, sessionQuestions],
    );

    React.useEffect(() => {
        if (!active || !currentSessionId || !effectiveSessionDirectory || !hasUnreconciledQuestionTool) return;
        let cancelled = false;

        void recoverPendingQuestionWithRetry(
            () => sync.recoverPendingQuestions(currentSessionId, effectiveSessionDirectory),
            { isCancelled: () => cancelled },
        );

        return () => {
            cancelled = true;
        };
    }, [active, currentSessionId, effectiveSessionDirectory, hasUnreconciledQuestionTool, sync]);

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
        return {
            limit: sessionMessages.length,
            complete: sessionMessageLoadState.complete || !sessionMessageLoadState.cursor,
            loading: sessionMessageLoadState.status === 'loading',
        };
    }, [currentSessionId, sessionMessageLoadState.complete, sessionMessageLoadState.cursor, sessionMessageLoadState.status, sessionMessages.length]);

    const { isMobile } = useDeviceInfo();
    const isVSCode = isVSCodeRuntime();
    const chatSurfaceMode = useChatSurfaceMode();
    const draftOpen = Boolean(newSessionDraft?.open);
    const isManagedChatContext = draftOpen
        ? newSessionDraft?.target === 'chat'
        : isChatDirectoryPath(effectiveSessionDirectory);
    // A draft can target another project or a pending worktree before it has a
    // session. Keep the panel on that same directory so its project, MCP, and
    // usage readouts describe where the draft will run rather than the project
    // the user came from.
    const workStatusDirectory = draftOpen
        ? (isManagedChatContext ? null : newSessionDraft?.bootstrapPendingDirectory ?? newSessionDraft?.directoryOverride ?? effectiveSessionDirectory)
        : effectiveSessionDirectory;
    const initError = useGlobalSyncStore((s) => s.error);
    // Despite the historical name, this now covers mobile too: the mobile
    // composer enters the same fullscreen-input mode via its drag handle.
    const isDesktopExpandedInput = isExpandedInput;
    const useCompactDraftLayout = isMobile || isVSCode || chatSurfaceMode === 'mini-chat';
    // Work-status panel: a borderless column to the right of the transcript.
    // It yields to the context panel and to a narrow chat; `rowRef` goes on the
    // row that holds both columns, so its width never depends on the panel's
    // own visibility.
    const { rowRef: workStatusRowRef, visible: workStatusVisible, fits: workStatusFits } = useWorkStatusVisibility({
        isMobile,
        isVSCode,
    });
    // Surfaces that never host the panel skip it entirely; the rest keep it
    // mounted so its visibility can animate rather than snap.
    const workStatusPanelMountable = !isMobile
        && !isVSCode
        && chatSurfaceMode !== 'mini-chat'
        && !isDesktopExpandedInput;
    const showWorkStatusPanel = workStatusPanelMountable && workStatusVisible;

    // Offered over the chat when there is no room beside it. The panel is still
    // switched on; only the layout refuses it.
    const workStatusPanelEnabled = useUIStore((state) => state.workStatusPanelEnabled);
    const workStatusOverlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
    const setWorkStatusPanelFits = useUIStore((state) => state.setWorkStatusPanelFits);
    // Mounted whenever it could be shown, not only while it is: an element
    // that appears and disappears with the condition has nothing to animate.
    const workStatusOverlayMountable = workStatusPanelMountable
        && workStatusPanelEnabled
        && !workStatusFits;
    const showWorkStatusOverlay = workStatusOverlayMountable && workStatusOverlayOpen;

    React.useEffect(() => {
        setWorkStatusPanelFits(workStatusPanelMountable && workStatusFits);
        return () => setWorkStatusPanelFits(false);
    }, [setWorkStatusPanelFits, workStatusFits, workStatusPanelMountable]);

    // Published so the header can drop the readouts the panel already carries.
    // Cleared on unmount: a chat that goes away is not showing anything.
    const setWorkStatusPanelVisible = useUIStore((state) => state.setWorkStatusPanelVisible);
    React.useEffect(() => {
        setWorkStatusPanelVisible(showWorkStatusPanel);
        return () => setWorkStatusPanelVisible(false);
    }, [setWorkStatusPanelVisible, showWorkStatusPanel]);
    const messageListRef = React.useRef<MessageListHandle | null>(null);

    const currentSession = useSession(currentSessionId, effectiveSessionDirectory);
    const parentSession = useParentSession(currentSessionId, effectiveSessionDirectory);

    // In the embedded session-chat iframe, hide "Return to parent" when
    // viewing the panel's anchor session (the one recorded in the URL). Going
    // up from the anchor would show the primary session that's already in the
    // main chat. Drilling into a deeper subtask (currentSessionId ≠ anchor)
    // re-enables the button to navigate back to the embedded session.
    const embeddedPanelAnchorSessionId = getEmbeddedSessionChatOriginSessionId();
    const hideReturnToParent =
        embeddedPanelAnchorSessionId !== null && currentSessionId === embeddedPanelAnchorSessionId;

    const handleReturnToParentSession = React.useCallback(() => {
        if (!parentSession) return;
        const parentDirectory = (parentSession as Session & { directory?: string | null }).directory ?? null;
        setCurrentSession(parentSession.id, parentDirectory);
    }, [parentSession, setCurrentSession]);

    const returnToParentButton = parentSession && !hideReturnToParent ? (
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
    const promptReadOnly = resolveChatPromptReadOnly(
        currentSession,
        embeddedAllowPrompting ?? allowPromptingSubagentSessions,
        readOnly,
    );

    React.useEffect(() => {
        // VS Code/Cursor/Positron webviews delete window.parent (and window.top).
        // The old `window.parent === window` check does not catch that, so
        // `window.parent.postMessage(...)` threw on chat open:
        // TypeError: Cannot read properties of undefined (reading 'postMessage')
        if (typeof window === 'undefined' || !window.parent || window.parent === window) {
            return;
        }

        const parentWindow = window.parent;
        const applySetting = (value: boolean) => {
            setEmbeddedAllowPrompting(value);
            useUIStore.getState().setAllowPromptingSubagentSessions(value);
        };
        const scopedWindow = window as typeof window & {
            __openchamberApplyChatSettingsSync?: (payload: { allowPromptingSubagentSessions: boolean }) => void;
        };
        const applySync = (payload: { allowPromptingSubagentSessions: boolean }) => {
            applySetting(payload.allowPromptingSubagentSessions);
        };
        const handleMessage = (event: MessageEvent) => {
            if (event.source !== parentWindow || event.origin !== window.location.origin) return;
            const data = event.data as { type?: unknown; payload?: { allowPromptingSubagentSessions?: unknown } };
            if (data?.type !== 'openchamber:chat-settings-sync'
                || typeof data.payload?.allowPromptingSubagentSessions !== 'boolean') return;
            applySetting(data.payload.allowPromptingSubagentSessions);
        };

        scopedWindow.__openchamberApplyChatSettingsSync = applySync;
        window.addEventListener('message', handleMessage);
        parentWindow.postMessage({ type: 'openchamber:chat-settings-request' }, window.location.origin);
        return () => {
            window.removeEventListener('message', handleMessage);
            if (scopedWindow.__openchamberApplyChatSettingsSync === applySync) {
                delete scopedWindow.__openchamberApplyChatSettingsSync;
            }
        };
    }, []);

    // Selection policy reads the live selection, not the deferred one: right
    // after a click the deferred id still names the previous session (or
    // nothing) for one commit, and acting on that would open a draft over the
    // session the user just chose.
    React.useEffect(() => {
        if (autoOpenDraft && !liveSessionId && !draftOpen) {
            // Programmatic fallback, not user navigation — must not clear the
            // persisted last-session pointer the cold-launch restore reads.
            openNewSessionDraft({ automatic: true });
        }
    }, [autoOpenDraft, liveSessionId, draftOpen, openNewSessionDraft]);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);

    // The composer sits below the timeline, but the status/working row floats
    // OVER the timeline's bottom edge; its measured height keeps the live
    // streaming line above it and reserves matching end inset in the list.
    const [statusOverlayHeight, setStatusOverlayHeight] = React.useState(0);
    // The reserve is fixed so the timeline's end does not move when the row
    // appears a commit after the session opened: a viewport pinned to the end
    // would otherwise be left sitting the row's height above it. Measurement
    // only extends the reserve for a taller row.
    const composerOverlayHeight = Math.max(STATUS_OVERLAY_RESERVED_HEIGHT, statusOverlayHeight);
    const statusOverlayObserverRef = React.useRef<ResizeObserver | null>(null);
    const onStatusOverlayNode = React.useCallback((node: HTMLDivElement | null) => {
        statusOverlayObserverRef.current?.disconnect();
        statusOverlayObserverRef.current = null;
        if (!node || !globalThis.ResizeObserver) {
            setStatusOverlayHeight(0);
            return;
        }
        const update = () => {
            // +8 for the mb-2 gap between the row and the composer, which the
            // node's own box does not include.
            const height = node.getBoundingClientRect().height + 8;
            setStatusOverlayHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height));
        };
        const observer = new ResizeObserver(update);
        observer.observe(node);
        statusOverlayObserverRef.current = observer;
        update();
    }, []);
    React.useEffect(() => () => {
        statusOverlayObserverRef.current?.disconnect();
        statusOverlayObserverRef.current = null;
    }, []);
    const lastUserMessageId = React.useMemo(() => {
        for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
            const message = sessionMessages[index];
            if (message.info.role === 'user') {
                return message.info.id;
            }
        }
        return null;
    }, [sessionMessages]);

    const {
        scrollRef,
        scrollNode,
        registerList,
        anchorMessageId,
        onAnchorReady,
        onAnchorSizeChanged,
        onIsAtEndChange,
        onManualNavigation,
        onTimelineDataChange,
        goToBottom,
        scrollToBottomOnSend,
        restoreSnapshot,
        isPinned,
        isFollowingProgrammatically,
        showScrollButton,
        userOwnsScroll,
    } = useChatTimelineScroll({
        currentSessionId,
        currentSessionKey,
        sessionMessageCount,
        composerOverlayHeight,
        lastUserMessageId,
        sessionIsWorking,
        revealGate,
        onActiveTurnChange: handleActiveTurnChange,
    });

    const viewportMessages = sessionMessages;

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
    // The list owns the scroll element, so the shadows and the load-older
    // trigger bind to its node rather than to a wrapper we render.
    const scrollNodeRef = React.useMemo(() => ({ current: scrollNode }), [scrollNode]);
    useScrollShadow(scrollNodeRef, {
        observeMutations: false,
        hideTopShadow: isMobile && stickyUserHeader,
    });

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

    // Mobile loads older history via an explicit top button instead of a
    // scroll-position trigger (see handleHistoryScroll in the controller).
    const showLoadOlderButton = isMobileSurfaceRuntime()
        && timelineController.historySignals.canLoadEarlier;
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
    }, [timelineController.handleActiveTurnChange]);

    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottomInstant,
    });
    const handlePromptNavigatorSelect = React.useCallback((turnId: string) => {
        // Instant on purpose: a long smooth scroll through a virtualized
        // timeline gets cancelled by row remounts and lands mid-way or on the
        // wrong message; a teleport always arrives.
        void navigation.scrollToTurnId(turnId, { behavior: 'auto' });
    }, [navigation]);
    const canLoadEarlierPrompts = timelineController.historySignals.canLoadEarlier;
    const showPromptNavigator = !isMobile
        && !isVSCode
        && !isDesktopExpandedInput
        && promptNavigatorEnabled
        && timelineController.turnIds.length >= 2;

    React.useEffect(() => {
        if (!showPromptNavigator) {
            useUIStore.getState().setPromptNavigatorPanelOpen(false);
        }
    }, [showPromptNavigator]);

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

            if (hasBlockingChatOverlay()) {
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

    const lastScrolledSessionKeyRef = React.useRef<string | null>(null);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasRenderableSessionSnapshot;
    const retrySessionLoad = React.useCallback(() => {
        if (!messagesEnabled || !currentSessionId) return;
        void sync.ensureSessionRenderable(currentSessionId, true, effectiveSessionDirectory);
    }, [currentSessionId, effectiveSessionDirectory, messagesEnabled, sync]);

    // A load that failed while the session was expired retries itself the
    // moment the re-login lands — the error screen should never outlive its
    // cause.
    React.useEffect(() => {
        if (authSessionExpired) {
            wasAuthExpiredRef.current = true;
            return;
        }
        if (wasAuthExpiredRef.current) {
            wasAuthExpiredRef.current = false;
            if (sessionMessageLoadState.status === 'error') {
                retrySessionLoad();
            }
        }
    }, [authSessionExpired, retrySessionLoad, sessionMessageLoadState.status]);


    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        if (lastScrolledSessionKeyRef.current === currentSessionKey) return;

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionKeyRef.current = currentSessionKey;
        if (hasHashTarget) {
            // Hash navigation handler will scroll to target; we just release auto-follow.
            onManualNavigation();
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
    }, [active, currentSessionId, currentSessionKey, onManualNavigation, restoreSnapshot]);

    React.useEffect(() => {
        if (!messagesEnabled || !currentSessionId) return;
        if (hasRenderableSessionSnapshot) return;
        void ensureSessionRenderable(currentSessionId);
    }, [currentSessionId, ensureSessionRenderable, hasRenderableSessionSnapshot, messagesEnabled]);

    const composerSlotRef = React.useRef<HTMLDivElement | null>(null);
    const previousComposerRectRef = React.useRef<DOMRect | null>(null);
    const previousDraftOpenRef = React.useRef(draftOpen);
    const previousDraftLayoutVisibleRef = React.useRef(draftOpen);
    const [draftExitAnimating, setDraftExitAnimating] = React.useState(false);
    const shouldAnimateDraftTransition = Boolean(
        currentSessionId && materializedDraftSessionId === currentSessionId,
    );
    const draftPresentationExiting = draftExitAnimating
        || (previousDraftOpenRef.current && !draftOpen && shouldAnimateDraftTransition);
    const draftLayoutVisible = draftOpen || draftPresentationExiting;

    React.useLayoutEffect(() => {
        if (draftOpen) {
            setDraftExitAnimating(false);
            return;
        }
        if (!previousDraftOpenRef.current || !shouldAnimateDraftTransition) return;

        setDraftExitAnimating(true);
        const timeoutId = window.setTimeout(() => setDraftExitAnimating(false), DRAFT_EXIT_DURATION_MS);
        return () => window.clearTimeout(timeoutId);
    }, [draftOpen, shouldAnimateDraftTransition]);

    React.useLayoutEffect(() => {
        previousDraftOpenRef.current = draftOpen;
    }, [draftOpen]);

    React.useLayoutEffect(() => {
        const composerSlot = composerSlotRef.current;
        if (!composerSlot) return;

        const composerEditor = composerSlot.querySelector('[data-testid="chat-input"]');
        const currentRect = composerEditor?.getBoundingClientRect() ?? composerSlot.getBoundingClientRect();
        const previousRect = previousComposerRectRef.current;
        const leftDraftLayout = previousDraftLayoutVisibleRef.current
            && !draftLayoutVisible
            && Boolean(currentSessionId);
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

        const shouldMoveComposer = leftDraftLayout && shouldAnimateDraftTransition;
        if (shouldMoveComposer && previousRect && !reduceMotion && !useCompactDraftLayout && !isDesktopExpandedInput) {
            const deltaX = previousRect.left - currentRect.left;
            const deltaY = previousRect.top - currentRect.top;
            composerSlot.animate(
                [
                    { transform: `translate(${deltaX}px, ${deltaY}px)` },
                    { transform: 'translate(0, 0)' },
                ],
                { duration: COMPOSER_MOVE_DURATION_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
            );
        }
        previousComposerRectRef.current = currentRect;
        previousDraftLayoutVisibleRef.current = draftLayoutVisible;
        if (leftDraftLayout && currentSessionId) {
            clearMaterializedDraftSession(currentSessionId);
        }
    }, [
        clearMaterializedDraftSession,
        currentSessionId,
        draftLayoutVisible,
        isDesktopExpandedInput,
        shouldAnimateDraftTransition,
        useCompactDraftLayout,
    ]);

	if (!currentSessionId && !draftOpen) {
		// The auto-open effect runs on the next tick. Use a neutral background
		// until then instead of flashing the standard empty state.
		if (autoOpenDraft && !initError) {
			return <div className="flex h-full flex-col bg-background" />;
		}
		return (
			<div className="flex flex-col h-full bg-background">
				<ChatEmptyState />
			</div>
		);
	}

    const sessionSurface = (() => {
        if (draftOpen || draftPresentationExiting) {
            if (!useCompactDraftLayout || isDesktopExpandedInput) {
                return null;
            }
            return <DraftWelcome exiting={draftPresentationExiting} />;
        }

        const showHydrationSkeleton = isSessionHydrating && sessionMessages.length === 0 && !sessionIsWorking;
        if (showHydrationSkeleton) {
            if (sessionMessageLoadState.status === 'error') {
                return (
                    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
                        <div className="max-w-sm text-center">
                            <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)] text-[var(--status-error)]">
                                <Icon name="error-warning" className="size-4" />
                            </div>
                            <p className="typography-ui-label font-medium text-foreground">{t('chat.container.sessionLoadError.title')}</p>
                            <p className="typography-meta mt-1 text-muted-foreground">
                                {authSessionExpired
                                    ? t('chat.container.sessionLoadError.authDescription')
                                    : t('chat.container.sessionLoadError.description')}
                            </p>
                            {authSessionExpired ? (
                                <Button variant="outline" size="sm" className="mt-4" onClick={() => useAuthSessionStore.getState().markReauthenticating()}>
                                    {t('sessionAuth.expired.loginAction')}
                                </Button>
                            ) : (
                                <Button variant="outline" size="sm" className="mt-4" onClick={retrySessionLoad}>
                                    {t('chat.container.sessionLoadError.retry')}
                                </Button>
                            )}
                        </div>
                    </div>
                );
            }

            return (
                <div
                    data-chat-hydration-skeleton=""
                    className={cn(
                        'relative min-h-0',
                        isDesktopExpandedInput ? 'pointer-events-none absolute inset-0 opacity-0' : 'flex-1',
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
                                                {item.toolRows.map((row) => (
                                                    <div key={`${item.id}-${row.id}`} className="flex items-center gap-2">
                                                        <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
                                                        <Skeleton className={cn('h-4 rounded-md', row.titleWidth)} />
                                                        <Skeleton className={cn('h-4 rounded-md', row.detailWidth)} />
                                                    </div>
                                                ))}
                                            </div>
                                            <div className="space-y-1.5 pt-1">
                                                {item.textWidths.map((width, index) => (
                                                    <Skeleton key={`${item.id}-text-${index}`} className={cn('h-4 rounded-md', width)} />
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            );
        }

        if (sessionMessages.length === 0 && !sessionIsWorking) {
            return (
                <div
                    className={cn(
                        'relative min-h-0',
                        isDesktopExpandedInput ? 'pointer-events-none absolute inset-0 opacity-0' : 'flex-1',
                    )}
                    aria-hidden={isDesktopExpandedInput}
                />
            );
        }

        return (
            <ChatViewport
                currentSessionId={currentSessionId ?? ''}
                currentSessionKey={currentSessionKey ?? currentSessionId ?? ''}
                isDesktopExpandedInput={isDesktopExpandedInput}
                isMobile={isMobile}
                directory={effectiveSessionDirectory}
                scrollRef={scrollRef}
                registerList={registerList}
                anchorMessageId={anchorMessageId}
                onAnchorReady={onAnchorReady}
                onAnchorSizeChanged={onAnchorSizeChanged}
                onIsAtEndChange={onIsAtEndChange}
                onTimelineDataChange={onTimelineDataChange}
                messageListRef={messageListRef}
                renderedMessages={timelineController.renderedMessages}
                isLoadingOlder={timelineController.isLoadingOlder}
                sessionIsWorking={sessionIsWorking}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                scrollToBottom={resumeToLatestInstant}
                endPinningReleased={userOwnsScroll}
                revealWaited={revealWaited}
                revealGate={revealGate}
                sessionQuestions={sessionQuestions}
                sessionPermissions={sessionPermissions}
                isProgrammaticFollowActive={isFollowingProgrammatically}
                showLoadOlderButton={showLoadOlderButton}
                onLoadOlder={handleLoadOlderClick}
                turnIds={timelineController.turnIds}
                activeTurnId={timelineController.activeTurnId}
                onSelectTurn={handlePromptNavigatorSelect}
                showPromptNavigator={showPromptNavigator}
                canLoadEarlierPrompts={canLoadEarlierPrompts}
                isLoadingOlderPrompts={timelineController.isLoadingOlder}
                onLoadEarlierPrompts={handleLoadOlderClick}
            />
        );
    })();

	return (
		<div ref={workStatusRowRef} className="flex h-full min-h-0 bg-background">
		<ChatColumnSessionContext.Provider value={chatColumnSession}>
		<div data-composer-bound className="relative flex min-w-0 flex-1 flex-col h-full bg-background">
			{returnToParentButton}
			{sessionSurface}

            <div
                ref={composerSlotRef}
                className={cn(
                    'relative z-10 flex min-h-0',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : draftLayoutVisible && !useCompactDraftLayout
                            ? 'flex-1 items-center justify-center bg-background pb-[6vh]'
                        : 'bg-background'
                )}
            >
                {!draftLayoutVisible && !isDesktopExpandedInput && sessionMessages.length > 0 && (
                    <>
                        <ScrollToBottomButton
                            visible={timelineController.showScrollToBottom}
                            working={sessionIsWorking}
                            onClick={navigation.resumeToLatest}
                        />
                        {/* Same anchor and column as the pill, so the status
                            row and the pill it hands off to share the exact
                            distance from the input and the same left edge. */}
                        <div
                            className={cn(
                                'pointer-events-none absolute bottom-full inset-x-0 mb-2 transition-opacity duration-100',
                                userOwnsScroll && 'opacity-0',
                            )}
                        >
                            <div className="chat-input-column">
                                {/* The glass chip itself is rendered inside
                                    StatusRow (its root is a size container
                                    that cannot shrink-wrap). */}
                                <div
                                    ref={onStatusOverlayNode}
                                    className={cn(
                                        '[&:not(:has(*))]:hidden',
                                        userOwnsScroll ? 'pointer-events-none' : 'pointer-events-auto',
                                    )}
                                >
                                    <StatusRowContainer />
                                </div>
                            </div>
                        </div>
                    </>
                )}
                {promptReadOnly ? (
                    <ReadOnlyPromptBanner />
                ) : (
                    <ChatInput
                        active={active}
                        scrollToBottom={scrollToBottomOnSend}
                        scrollToLatest={resumeToLatestInstant}
                        draftPresentationExiting={draftPresentationExiting}
                    />
                )}
            </div>

            {/* Inside the chat column, not beside it: as a row sibling it took
                part in the flex layout and pushed the transcript, which is the
                one thing an overlay must not do. */}
            {workStatusOverlayMountable ? (
                <WorkStatusPanel
                    overlay
                    visible={showWorkStatusOverlay}
                    sessionId={currentSessionId ?? null}
                    directory={workStatusDirectory ?? null}
                    repositoryEnabled={!isManagedChatContext}
                />
            ) : null}

            <TimelineDialog
                open={isTimelineDialogOpen}
                onOpenChange={setTimelineDialogOpen}
                onScrollToMessage={timelineController.scrollToMessage}
                onScrollByTurnOffset={navigation.scrollByTurnOffset}
                onResumeToLatest={resumeToLatestInstant}
                canLoadEarlier={timelineController.historySignals.canLoadEarlier}
                isLoadingEarlier={timelineController.isLoadingOlder}
                onLoadEarlier={handleLoadOlderClick}
            />
        </div>
        </ChatColumnSessionContext.Provider>
        {/* Kept mounted while it could ever show, so it can animate its own
            collapse; `visible` drives that. Unmounting on the spot is what made
            the chat jump wide before easing narrow again. */}
        {workStatusPanelMountable ? (
            <WorkStatusPanel
                visible={showWorkStatusPanel}
                sessionId={currentSessionId ?? null}
                directory={workStatusDirectory ?? null}
                repositoryEnabled={!isManagedChatContext}
            />
        ) : null}
        </div>
    );
};
