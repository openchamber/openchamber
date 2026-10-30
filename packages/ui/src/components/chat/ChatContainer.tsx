import React from 'react';
import { SessionRecapNote } from '@/components/chat/SessionRecapSpacer';
import { DraftProjectName } from '@/components/chat/DraftProjectName';
import { createPortal } from 'react-dom';
import type { Message, Part, Session } from '@/lib/opencode/model';
import { getLastConversationRecord, isIncompleteAssistantTurn } from '@/lib/opencode/model';
import { keepCommandSubagentReports } from '@/lib/opencode/subagent-run';
import { isOpencodeNotFound, opencodeClient } from '@/lib/opencode/client';

import { ChatInput } from './ChatInput';
import { CHAT_INPUT_EDITOR_SELECTOR } from './composer/editor/dom';
import {
    ChatColumnActionsContext,
    ChatColumnSessionContext,
    useChatColumnActions,
    type ChatColumnActions,
    type ChatColumnSession,
} from './chatColumnSession';
import { MobileCommentComposerContext, useMobileCommentComposerOwner } from './composer/comment/MobileCommentComposerContext';
import { DraftPresetChips } from './DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import { KeepAlive } from '@/components/ui/KeepAlive';
import ChatEmptyState from './ChatEmptyState';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import MessageList, { type MessageListHandle } from './MessageList';
import { createTimelineRevealGate, type TimelineRevealGate } from './timelineRevealGate';

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
// Mirrors the oc-chat-hydration-reveal duration in index.css.
const TIMELINE_REVEAL_FADE_MS = 100;
// After a turn starts or ends, how long the transcript settles before an
// overgrown history is cut back: past the scroll hook's 2 s send glide and
// 1 s turn-end glide windows.
const HISTORY_TRIM_DELAY_MS = 3000;
import { hasActiveFormToolInCurrentTurn, recoverPendingFormWithRetry } from '@/sync/form-recovery';
import { toast } from '@/components/ui';
import { StatusRowContainer } from './StatusRowContainer';
import {
    FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX,
    FLOATING_COMPOSER_GAP_PX,
    forgetComposerSlot,
    recordComposerSlotHeight,
} from '@/components/chat/composer/state/composerTailInset';
import {
    publishComposerInsets,
    registerComposerInsetReader,
    registerFloatingPanelClearanceReader,
    withdrawComposerInsets,
} from '@/components/chat/composer/state/composerInsetReaders';
import { SessionErrorNotice } from '@/components/chat/SessionErrorNotice';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { PromptNavigatorRail } from './components/PromptNavigatorRail';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useScrollShadow } from '@/components/ui/useScrollShadow';
import { useChatTimelineScroll, type LinkedMessageState, type TimelineListHandle } from '@/hooks/useChatTimelineScroll';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { TimelineDialog } from './TimelineDialog';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { ChatQuoteHighlightContext, useChatQuoteHighlightStore } from './hooks/chatQuoteHighlightStore';
import { ChatQuoteHighlightLayer } from './message/ChatQuoteHighlightLayer';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useAutoReadAloud } from '@/hooks/useAutoReadAloud';
import { findLatestCompletedReply } from '@/lib/messages/latestReply';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { StopIcon } from '@/components/icons/StopIcon';
import { abortCurrentOperation } from '@/sync/session-actions';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from "@/components/icon/Icon";
import { cn, formatDirectoryName } from '@/lib/utils';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useProjectsStore } from '@/stores/useProjectsStore';

// New sync system imports
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useChildStoreManager,
    useSessionMessageRecords,
    useSessionMessageLoadState,
    useSessionMessageLoader,
    useSyncDirectory,
    useSessionRenderable,
    useSessionStatus,
    useScopedBlockingPermissions,
    useScopedBlockingForms,
    useParentSession,
    useSession,
    useSessionStartTimes,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useI18n } from '@/lib/i18n';
import { useDraftHeading } from './useDraftHeading';
import { isVSCodeRuntime } from '@/lib/desktop';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { ChatSearchBar } from './search/ChatSearchBar';
import { WorkStatusPanel } from './work-status/WorkStatusPanel';
import { useWorkStatusVisibility } from './work-status/useWorkStatusVisibility';
import { useShownSessionSelection } from './useShownSessionSelection';
import { usePinnedSessionDirectory } from './usePinnedSessionDirectory';
import { useRightSlotStore } from '@/components/layout/rightSlot';
import { buildPromptPreviewsByTurnId } from './lib/promptPreviews';
import { resolveChatPromptReadOnly } from './chatPromptReadOnly';
import { PermissionDock } from './PermissionDock';
import { FormDock } from './FormDock';
import { ensureSpaceArchives, useSpaceArchiveOf } from '@/lib/spaces/space-archives';
import { useSpaceDirectoryStopped } from '@/lib/spaces/spaces-store';
import { SpaceChatPlaceholder } from '@/components/session/spaces/SpaceChatPlaceholder';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
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
        isProjectActionsDialogOpen,
        isImagePreviewOpen,
        runOverviewKey,
        isSessionSwitcherOpen,
        isSettingsDialogOpen,
    } = useUIStore.getState();

    return isAboutDialogOpen
        || isCommandPaletteOpen
        || isHelpDialogOpen
        || isProjectActionsDialogOpen
        || isImagePreviewOpen
        || runOverviewKey !== null
        || isSessionSwitcherOpen
        || isSettingsDialogOpen;
};

type HydratingToolSkeletonRow = {
    id: string;
    titleWidth: string;
    detailWidth: string;
};

type ChatViewportProps = {
    /** Loading, error, draft or empty content; undefined shows the transcript. */
    placeholder: React.ReactNode;
    currentSessionId: string;
    currentSessionKey: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    /** The composer floats over the transcript and reserves its band via
        `--chat-composer-tail-inset` on the tail spacer (composerInsetReaders). */
    floatingComposer: boolean;
    /** Height the floating status row takes above the composer while the
        session works, px; 0 when there is no row. */
    statusRowClearance: number;
    directory?: string;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    registerList: (list: TimelineListHandle | null, sessionKey?: string) => void;
    onIsAtEndChange: (isAtEnd: boolean) => void;
    onListMetricsChange: (metrics: { readonly footerSize: number }) => void;
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
    /** A drag on the overlay scrollbar's thumb takes the scroll from auto-follow. */
    onScrollbarDrag: () => void;
    endPinningReleased: boolean;
    /** The user waited for this session (held or fetched); reveal it with a fade. */
    revealWaited: boolean;
    revealGate: TimelineRevealGate;
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

// Sessions kept mounted per chat column, the open one included, so returning
// to a recent one reuses its timeline. Each retained timeline costs a few MB
// of DOM, and a phone's web view is killed under memory pressure, so the
// mobile surface keeps only the open session.
const retainedTimelines = () => (isMobileSurfaceRuntime() ? 1 : 4);

const ChatViewport = React.memo(({
    placeholder,
    currentSessionId,
    currentSessionKey,
    isDesktopExpandedInput,
    isMobile,
    floatingComposer,
    statusRowClearance,
    directory,
    scrollRef,
    messageListRef,
    registerList,
    onIsAtEndChange,
    onListMetricsChange,
    onTimelineDataChange,
    renderedMessages,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    scrollToBottom,
    onScrollbarDrag,
    endPinningReleased,
    revealWaited,
    revealGate,
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
    const session = React.useMemo<ChatColumnSession>(() => ({
        sessionId: currentSessionId,
        directory: directory ?? null,
    }), [currentSessionId, directory]);
    const registerSessionList = React.useCallback((list: TimelineListHandle | null) => {
        registerList(list, currentSessionKey);
    }, [currentSessionKey, registerList]);
    const showingTranscript = placeholder === undefined;
    const promptPreviewsByTurnIdRef = React.useRef<Map<string, Part[]>>(new Map());
    const promptPreviewsByTurnId = React.useMemo(() => {
        const next = buildPromptPreviewsByTurnId(renderedMessages);
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
    //
    // The header is a fixed-height slot that is always there, button or not.
    // A header that came and went with history coverage changed the height
    // above the rows, and a reader on the end saw the whole transcript jump
    // by it (after a revert, mid-send). Only the button inside it toggles.
    const listHeader = React.useMemo(() => (
        <div className="flex h-12 justify-center pt-3 pb-1">
            {showLoadOlderButton ? (
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
            ) : null}
        </div>
    ), [isLoadingOlder, onLoadOlder, showLoadOlderButton, t]);

    const listFooter = React.useMemo(() => (
        <>
            {/* Permissions and forms dock above the composer (`PermissionDock`, `FormDock`). */}
            <SessionErrorNotice sessionId={currentSessionId} directory={directory} />

            {/* Tail spacer. With a floating composer it reserves the band the
                composer covers, plus any panel docked above it (queue, BTW),
                so the end of the transcript stays readable above them; the
                extra gap is the breathing room between the last row and the
                top edge of whatever floats. Both heights come from CSS
                variables written straight by observers (the composer's onto
                this element itself, see composerInsetReaders), so a growing
                composer or panel resizes the footer without a list re-render;
                the list's own footer observer then extends the content.
                While the session works, the composer gets no growth
                allowance: the status row and the live end fade sit in the
                gap, so a composer grown into it (a background command, a
                queued message) left the last line under the row. */}
            <div
                ref={registerComposerInsetReader}
                className="relative flex-shrink-0"
                style={{
                    height: floatingComposer
                        ? `calc(${sessionIsWorking
                            ? `max(var(--chat-composer-tail-inset, ${FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX}px), var(--chat-composer-inset, 0px) + ${FLOATING_COMPOSER_GAP_PX}px)`
                            : `var(--chat-composer-tail-inset, ${FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX}px)`} + var(--chat-floating-panel-clearance, 0px))`
                        : (isMobile ? '40px' : '10vh'),
                }}
            >
                {/* The recap of the latest answer lies at the top of this band,
                    right under the answer's footer: it takes no room, so its
                    arrival and leaving move nothing. Rows of the list paint
                    only inside their own box (`contain: paint`), so it lives
                    here rather than in the answer's row. It goes once a new
                    prompt makes the session busy, and while the composer grows
                    into the band or a panel docks over it (design-system.css). */}
                {floatingComposer && currentSessionId ? (
                    <div className="oc-recap-hint pointer-events-none absolute inset-x-0 top-0 transition-opacity duration-300 ease-out">
                        <div className="chat-message-column">
                            <SessionRecapNote sessionId={currentSessionId} directory={directory} isMobile={isMobile} />
                        </div>
                    </div>
                ) : null}
            </div>
        </>
    ), [currentSessionId, directory, floatingComposer, isMobile, sessionIsWorking]);

    const endFadeStyle: React.CSSProperties & Record<'--chat-status-row-clearance', string> = {
        '--chat-status-row-clearance': `${statusRowClearance}px`,
    };

    // Opening a session paints the timeline as one finished picture: the root
    // stays invisible only until the viewport is in place (the scroll hook's
    // hold) and the list's measured heights settle, then everything appears
    // together. Markdown does not hold it: its first paint already has the
    // final geometry and highlighting only recolours code. A session the user
    // waited for fades in once as a whole.
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
        if (!root || !showingTranscript) return;
        root.setAttribute('data-timeline-reveal', 'pending');
        let finished = false;
        let timer: number | null = null;
        let frame: number | null = null;
        let fadeTimer: number | null = null;
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
                if (!fade) {
                    root.removeAttribute('data-timeline-reveal');
                    return;
                }
                root.setAttribute('data-timeline-reveal', 'fading');
                // The fade is a filled opacity animation, and a filled
                // animation keeps the root a stacking context for as long
                // as the attribute stays. That would trap the overlay
                // scrollbar (z-30) under the composer slot (z-10): the thumb
                // paints over the composer band but cannot be grabbed there.
                // Drop the attribute once the fade has run (or immediately
                // under reduced motion, where the animation never fires).
                const clearFade = (event?: AnimationEvent) => {
                    // Child entrance animations bubble here too.
                    if (event && event.target !== root) return;
                    if (fadeTimer !== null) window.clearTimeout(fadeTimer);
                    fadeTimer = null;
                    root.removeEventListener('animationend', clearFade);
                    root.removeAttribute('data-timeline-reveal');
                };
                root.addEventListener('animationend', clearFade);
                fadeTimer = window.setTimeout(clearFade, TIMELINE_REVEAL_FADE_MS * 2);
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
            timer = window.setTimeout(() => reveal(true), revealGate.capMs);
        });
        return () => {
            finished = true;
            if (timer !== null) window.clearTimeout(timer);
            if (frame !== null) window.cancelAnimationFrame(frame);
            if (fadeTimer !== null) window.clearTimeout(fadeTimer);
            revealGate.onEmpty = null;
        };
    }, [revealGate, scrollRef, showingTranscript]);

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
        <>
            {placeholder}
            <div
                className={cn(
                    'relative min-h-0',
                    isDesktopExpandedInput
                        ? 'absolute inset-0 opacity-0 pointer-events-none'
                        : 'flex-1',
                )}
                ref={timelineRootRef}
                style={showingTranscript ? undefined : { display: 'none' }}
                aria-hidden={isDesktopExpandedInput}
            >
                <div className="absolute inset-0">
                    {/* Retained by session ID: the session key also holds the
                        directory, which settles after the session opens, and
                        a key change left a hidden second copy of the open
                        session. The list still remounts on a key change. */}
                    <KeepAlive
                        key={getRuntimeKey()}
                        cacheKey={showingTranscript ? currentSessionId : null}
                        capacity={retainedTimelines()}
                    >
                        <ChatColumnSessionContext.Provider value={session}>
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
                                registerList={registerSessionList}
                                // The footer already reserves the composer's band.
                                composerOverlayHeight={0}
                                onIsAtEndChange={onIsAtEndChange}
                                onListMetricsChange={onListMetricsChange}
                                onTimelineDataChange={onTimelineDataChange}
                                listHeader={listHeader}
                                listFooter={listFooter}
                                scrollContainerProps={scrollContainerProps}
                            />
                        </ChatColumnSessionContext.Provider>
                    </KeepAlive>
                    {/* The transcript's edge fades must follow the scroller. */}
                    <div aria-hidden="true" className="chat-scroll-fade chat-scroll-fade--top" />
                    <div
                        ref={registerComposerInsetReader}
                        aria-hidden="true"
                        className="chat-scroll-fade chat-scroll-fade--end"
                        style={endFadeStyle}
                    />
                    <OverlayScrollbar
                        containerRef={scrollRef}
                        disableHorizontal
                        suppressVisibility={isProgrammaticFollowActive}
                        userIntentOnly
                        observeMutations={false}
                        onThumbDragStart={onScrollbarDrag}
                    />
                    {showPromptNavigator && promptTurnIds.length >= 2 ? (
                        <PromptNavigatorRail
                            sessionId={currentSessionId}
                            directory={directory}
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
        </>
    );
}, (prev, next) => {
    return prev.currentSessionId === next.currentSessionId
        && prev.placeholder === next.placeholder
        && prev.currentSessionKey === next.currentSessionKey
        && prev.isDesktopExpandedInput === next.isDesktopExpandedInput
        && prev.isMobile === next.isMobile
        && prev.floatingComposer === next.floatingComposer
        && prev.statusRowClearance === next.statusRowClearance
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
        && prev.onScrollbarDrag === next.onScrollbarDrag
        && prev.onListMetricsChange === next.onListMetricsChange
        && prev.endPinningReleased === next.endPinningReleased
        && prev.revealWaited === next.revealWaited
        && prev.revealGate === next.revealGate
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

// Session messages loading. The wait can last minutes while OpenCode fails to
// start, so the rows blink on the shared 1 s tick instead of pulsing, and stand
// still while hidden behind the expanded composer.
const HydrationSkeleton: React.FC<{ waiting: boolean }> = ({ waiting }) => {
    const blink = useWaitingBlink(waiting);
    return (
        <div className={cn('space-y-4', blink)}>
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
    );
};

// `onStop` is set while a subagent's turn runs: its session takes no
// prompts, but the user can still stop it from here.
const ReadOnlyPromptBanner: React.FC<{ text: string; onStop?: () => void; stopLabel?: string }> = ({ text, onStop, stopLabel }) => (
    <div className="w-full py-3" data-composer-transient="">
        <div className="chat-input-column">
            <div className="flex items-center gap-2 rounded-2xl border border-edge bg-[var(--surface-background)] px-4 py-3 typography-ui-label text-muted-foreground">
                <span className="min-w-0 flex-1 text-center">{text}</span>
                {onStop ? (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="-my-1.5 -me-2 shrink-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
                        onClick={onStop}
                        aria-label={stopLabel}
                        title={stopLabel}
                    >
                        <StopIcon className="size-4" />
                    </Button>
                ) : null}
            </div>
        </div>
    </div>
);

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
            <DraftProjectName label={projectLabel} />
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

const DraftWelcome: React.FC<{ exiting?: boolean }> = ({ exiting = false }) => {
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
    const draftHeading = useDraftHeading(projectLabel);

    return (
        <div className={cn(
            'oc-draft-center flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
            exiting && 'pointer-events-none opacity-0',
        )}>
            <h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
                {renderDraftTitle(draftHeading, projectLabel)}
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
    autoOpenDraft?: boolean;
    readOnly?: boolean;
    /**
     * Shows this session instead of the app's selection: a chat opened in the
     * side panel. The column navigates inside itself (open a subtask, return
     * to the parent) and never changes the main chat's selection, draft, or
     * panels.
     */
    pinnedSession?: { sessionId: string; directory: string | null };
};

type PinnedSelection = { sessionId: string; directory: string | null };

export const ChatContainer: React.FC<ChatContainerProps> = ({
    active = true,
    autoOpenDraft: autoOpenDraftProp = true,
    readOnly = false,
    pinnedSession,
}) => {
    const pinned = pinnedSession !== undefined;
    const autoOpenDraft = autoOpenDraftProp && !pinned;
    const { t } = useI18n();
    // A pinned column starts on its session and moves only through its own
    // navigation. A different session from the owner starts it over.
    const [pinnedOrigin, setPinnedOrigin] = React.useState<PinnedSelection | null>(pinnedSession ?? null);
    const [pinnedSelection, setPinnedSelection] = React.useState<PinnedSelection | null>(pinnedSession ?? null);
    if (pinnedSession && (pinnedSession.sessionId !== pinnedOrigin?.sessionId || pinnedSession.directory !== pinnedOrigin?.directory)) {
        setPinnedOrigin(pinnedSession);
        setPinnedSelection(pinnedSession);
    }
    // Session UI state. The selection is published synchronously by the
    // sidebar click, but the chat swaps its content on a deferred copy: the
    // first commit paints the cheap reactions (active row, URL, tab) while the
    // timeline for the new session renders in an interruptible transition
    // behind it. Both fields travel as one value so the key, the message
    // subscription, and the loader target never mix an old directory with a
    // new session id. A pinned column does not subscribe to the selection.
    const globalSessionId = useSessionUIStore((s) => (pinned ? null : s.currentSessionId));
    const globalSessionDirectory = useSessionUIStore((s) => (pinned ? null : s.currentSessionDirectory));
    const pinnedSessionDirectory = usePinnedSessionDirectory(pinned ? pinnedSelection : null);
    const liveSessionId = pinned ? (pinnedSessionDirectory ? pinnedSelection?.sessionId ?? null : null) : globalSessionId;
    const liveSessionDirectory = pinned ? pinnedSessionDirectory : globalSessionDirectory;
    const materializedDraftSessionId = useSessionUIStore((s) => (pinned ? null : s.materializedDraftSessionId));
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
    const { sessionId: currentSessionId, directory: currentSessionDirectory } = useShownSessionSelection(targetSelection);
    shownSelectionRef.current = { sessionId: currentSessionId, directory: currentSessionDirectory };
    const revealWaited = Boolean(currentSessionId) && currentSessionId === waitedSessionIdRef.current;

    const clearMaterializedDraftSession = useSessionUIStore((s) => s.clearMaterializedDraftSession);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);

    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    const messageLoader = useSessionMessageLoader();
    // The app bootstraps only the current directory and the selected
    // session's. A pinned column may show a session of another project, so it
    // asks for its own directory while it is open.
    const childStores = useChildStoreManager();
    const columnDemandOwner = `chat-column:${React.useId()}`;
    React.useEffect(() => {
        if (!pinned || !effectiveSessionDirectory) return;
        childStores.setBootstrapDemand(columnDemandOwner, [{
            directory: effectiveSessionDirectory,
            priority: 'selected',
            reason: 'selected-session',
        }]);
        return () => childStores.clearBootstrapDemand(columnDemandOwner);
    }, [childStores, columnDemandOwner, effectiveSessionDirectory, pinned]);
    const currentSessionKey = currentSessionId
        ? JSON.stringify([getRuntimeKey(), effectiveSessionDirectory, currentSessionId])
        : null;
    // A deferred switch can keep the previous transcript on screen after the
    // selected session changes. Protect what is actually rendered until commit.
    React.useLayoutEffect(() => {
        if (!currentSessionKey || !currentSessionId || !effectiveSessionDirectory) return;
        return messageLoader.retainSessionHistory({ directory: effectiveSessionDirectory, sessionID: currentSessionId }, 'rendered');
    }, [currentSessionKey, currentSessionId, effectiveSessionDirectory, messageLoader]);
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
    const mobileCommentComposer = useMobileCommentComposerOwner();
    const ensureSessionRenderable = React.useCallback(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId, false, effectiveSessionDirectory),
        [effectiveSessionDirectory, sync],
    );
    const loadMoreMessages = React.useCallback(
        (sessionId: string, _direction: 'up' | 'down') => sync.loadMore(sessionId, effectiveSessionDirectory),
        [effectiveSessionDirectory, sync],
    );

    // UI store
    const isExpandedInput = useUIStore((state) => (pinned ? false : state.isExpandedInput));
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
    // The timeline dialog of the main chat is app state (a global shortcut
    // opens it); a pinned column keeps its own.
    const globalTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setGlobalTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);
    const [pinnedTimelineDialogOpen, setPinnedTimelineDialogOpen] = React.useState(false);
    const isTimelineDialogOpen = pinned ? pinnedTimelineDialogOpen : globalTimelineDialogOpen;
    const setTimelineDialogOpen = pinned ? setPinnedTimelineDialogOpen : setGlobalTimelineDialogOpen;
    const columnRootRef = React.useRef<HTMLDivElement | null>(null);
    const pinnedColumnActions = React.useMemo<ChatColumnActions | null>(() => (pinned ? {
        pinned: true,
        openSession: (sessionId, directory) => setPinnedSelection({ sessionId, directory }),
        openTimelineDialog: () => setPinnedTimelineDialogOpen(true),
        focusInput: () => columnRootRef.current?.querySelector<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR)?.focus(),
    } : null), [pinned]);
    const inheritedColumnActions = useChatColumnActions();
    const columnActions = pinnedColumnActions ?? inheritedColumnActions;

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
    const hasRenderableSessionSnapshot = useSessionRenderable(currentSessionId ?? '', effectiveSessionDirectory);
    // Messages from sync system.
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory, {
        enabled: active,
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
    // The messages of a space's session live inside the space: while it is stopped, gone or out
    // of reach a load only waits for its timeout, so the chat holds it and says why instead.
    const spaceStopped = useSpaceDirectoryStopped(effectiveSessionDirectory);
    const [firstVisiblePerformance] = React.useState(createFirstVisibleSessionPerformanceTracker);

    React.useEffect(() => {
        if (!active || !currentSessionKey || !hasRenderableSessionSnapshot || sessionMessages.length === 0) return;
        return firstVisiblePerformance.schedule(currentSessionKey, sessionMessages.length);
    }, [active, currentSessionKey, firstVisiblePerformance, hasRenderableSessionSnapshot, sessionMessages.length]);

    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory) ?? IDLE_SESSION_STATUS;

    // Scoped blocking requests — only subscribe to permissions/forms for
    // the current session + descendant subagent sessions, not all sessions in
    // the directory.
    const sessionPermissions = useScopedBlockingPermissions(currentSessionId, effectiveSessionDirectory);
    const sessionForms = useScopedBlockingForms(currentSessionId, effectiveSessionDirectory);

    const hasUnreconciledFormTool = React.useMemo(
        () => !sessionForms.some((form) => form.sessionID === currentSessionId)
            && hasActiveFormToolInCurrentTurn(sessionMessages),
        [currentSessionId, sessionMessages, sessionForms],
    );

    React.useEffect(() => {
        if (!active || !currentSessionId || !effectiveSessionDirectory || !hasUnreconciledFormTool) return;
        let cancelled = false;

        void recoverPendingFormWithRetry(
            () => sync.recoverPendingQuestions(currentSessionId, effectiveSessionDirectory),
            { isCancelled: () => cancelled },
        );

        return () => {
            cancelled = true;
        };
    }, [active, currentSessionId, effectiveSessionDirectory, hasUnreconciledFormTool, sync]);

    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionForms.length > 0) {
            return false;
        }

        const statusType = sessionStatusForCurrent.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }

        // The last record can be a synthetic/skill/shell/switch message; the
        // turn is still running only per the last conversation message.
        return isIncompleteAssistantTurn(getLastConversationRecord(sessionMessages)?.info);
    }, [currentSessionId, sessionMessages, sessionPermissions.length, sessionForms.length, sessionStatusForCurrent.type]);

    const latestCompletedReply = React.useMemo(
        () => findLatestCompletedReply(sessionMessages),
        [sessionMessages],
    );
    const autoReadAloudEnabled = useConfigStore((state) => state.autoReadAloudEnabled);
    // Use the reply's own message id as the reading key so the message
    // button shows the auto-started reading as playing and can stop it.
    const { play: playAutoReadAloud } = useMessageTTS(latestCompletedReply?.messageId);
    // Permission prompts pause `sessionIsWorking` while the turn is still
    // running, so status also marks the session as active for the auto-read
    // baseline.
    const sessionIsActive = sessionIsWorking
        || sessionStatusForCurrent.type === 'busy'
        || sessionStatusForCurrent.type === 'retry';
    useAutoReadAloud({
        sessionKey: currentSessionKey ?? '',
        ready: hasRenderableSessionSnapshot && sessionMessageLoadState.status === 'ready',
        sessionIsActive,
        reply: latestCompletedReply,
        enabled: autoReadAloudEnabled && !pinned,
        play: playAutoReadAloud,
    });

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
    // The new-session draft is the main chat's; a pinned column never shows it.
    const draftOpen = !pinned && Boolean(newSessionDraft?.open);
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
    // It yields to a narrow chat, and to the context panel unless the chat area
    // fits both beside the transcript; `rowRef` goes on the row that holds both
    // columns, so its width never depends on the panel's own visibility.
    const {
        rowRef: workStatusRowRef,
        visible: workStatusVisible,
        fits: workStatusFits,
        roomy: workStatusRoomy,
        roomyBesidePanel: workStatusRoomyBesidePanel,
    } = useWorkStatusVisibility({
        isMobile,
        isVSCode,
    });
    const attachColumnRoot = React.useCallback((node: HTMLDivElement | null) => {
        columnRootRef.current = node;
        workStatusRowRef(node);
    }, [workStatusRowRef]);
    // Surfaces that never host the panel skip it entirely; the rest keep it
    // mounted so its visibility can animate rather than snap.
    // A pinned column leaves the panel, and the app-wide flags below, to the
    // main chat.
    const workStatusPanelMountable = !isMobile
        && !isVSCode
        && !pinned
        && chatSurfaceMode !== 'mini-chat';
    const showWorkStatusPanel = workStatusPanelMountable && workStatusVisible;
    // The inline card renders in the right slot beside the chat, which owns
    // the one width animation for the card and the context panel together
    // (components/layout/rightSlot.ts).
    const workStatusHost = useRightSlotStore((state) => state.workStatusHost);

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
    // The slot keeps the card's column while the context panel covers it.
    const workStatusReserved = workStatusPanelMountable && workStatusPanelEnabled && workStatusRoomy;
    const showWorkStatusOverlay = workStatusOverlayMountable && workStatusOverlayOpen;

    React.useEffect(() => {
        if (pinned) return;
        setWorkStatusPanelFits(workStatusPanelMountable && workStatusFits);
        return () => setWorkStatusPanelFits(false);
    }, [pinned, setWorkStatusPanelFits, workStatusFits, workStatusPanelMountable]);

    // Published so the header can drop the readouts the panel already carries.
    // Cleared on unmount: a chat that goes away is not showing anything.
    const setWorkStatusPanelVisible = useUIStore((state) => state.setWorkStatusPanelVisible);
    React.useEffect(() => {
        if (pinned) return;
        setWorkStatusPanelVisible(showWorkStatusPanel);
        return () => setWorkStatusPanelVisible(false);
    }, [pinned, setWorkStatusPanelVisible, showWorkStatusPanel]);
    const messageListRef = React.useRef<MessageListHandle | null>(null);

    const currentSession = useSession(currentSessionId, effectiveSessionDirectory);
    const parentSession = useParentSession(currentSessionId, effectiveSessionDirectory);

    // A pinned column hides "Return to parent" on the session it was opened
    // on: going up from there would show the session the main chat already
    // has. Drilling into a deeper subtask brings the button back, to return to
    // the pinned session.
    const hideReturnToParent = pinned && currentSessionId === pinnedOrigin?.sessionId;

    const openColumnSession = columnActions.openSession;
    const handleReturnToParentSession = React.useCallback(() => {
        if (!parentSession) return;
        const parentDirectory = (parentSession as Session & { directory?: string | null }).directory ?? null;
        openColumnSession(parentSession.id, parentDirectory);
    }, [openColumnSession, parentSession]);

    const returnToParentButton = parentSession && !hideReturnToParent ? (
        <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleReturnToParentSession}
            className="absolute inset-s-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95"
            aria-label={t('chat.container.returnToParent.aria')}
            title={parentSession.title?.trim()
                ? t('chat.container.returnToParent.titleNamed', { title: parentSession.title })
                : t('chat.container.returnToParent.title')}
        >
            <Icon name="arrow-left" className="h-4 w-4" />
            {t('chat.container.returnToParent.label')}
        </Button>
    ) : null;
    // A chat of a deleted isolated space is on the Archive page and read-only; the server refuses
    // to run it whatever the screen shows. Its directory is the archive's own, and the list of
    // archives is read once per runtime. A draft opened after such a chat still sits in the
    // archive's directory until it is sent, and is not read-only: it is a new chat.
    React.useEffect(() => {
        ensureSpaceArchives();
    }, []);
    const spaceArchive = useSpaceArchiveOf(currentSessionId ? effectiveSessionDirectory : null);
    const promptReadOnly = spaceArchive !== null || resolveChatPromptReadOnly(
        currentSession,
        allowPromptingSubagentSessions,
        readOnly,
    );


    // Selection policy reads the live selection, not the deferred one: right
    // after a click the deferred id still names the previous session (or
    // nothing) for one commit, and acting on that would open a draft over the
    // session the user just chose.
    React.useEffect(() => {
        if (!autoOpenDraft || liveSessionId || draftOpen) return;
        // Checked again against the store when the effect runs: a session link
        // can select a session between this render and the effect (a startup
        // route, Strict Mode's effect replay), and a draft opened from the
        // stale render would throw that selection away.
        const live = useSessionUIStore.getState();
        if (live.currentSessionId || live.newSessionDraft.open) return;
        // Programmatic fallback, not user navigation — must not clear the
        // persisted last-session pointer the cold-launch restore reads.
        openNewSessionDraft({ automatic: true });
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
    // The timeline controller owns history loading and needs this hook's
    // scroll commands, so the hook reaches the loader through a ref.
    const loadHistoryUntilMessageRef = React.useRef<(messageId: string, maxBatches: number) => Promise<boolean>>(async () => false);
    const loadHistoryUntilMessage = React.useCallback(
        (messageId: string, maxBatches: number) => loadHistoryUntilMessageRef.current(messageId, maxBatches),
        [],
    );
    const handleLinkedMessageMissing = React.useCallback(() => {
        toast.info(t('chat.messageLink.notFound'));
    }, [t]);
    // One request settles whether a linked message exists before the timeline
    // pages through the whole history toward it. Only a 404 means missing.
    const checkLinkedMessage = React.useCallback(async (messageId: string): Promise<LinkedMessageState> => {
        if (!currentSessionId) return 'unknown';
        try {
            await opencodeClient.getSessionMessage(currentSessionId, messageId, effectiveSessionDirectory);
            return 'exists';
        } catch (error) {
            return isOpencodeNotFound(error) ? 'missing' : 'unknown';
        }
    }, [currentSessionId, effectiveSessionDirectory]);
    const {
        scrollRef,
        scrollNode,
        registerList,
        onIsAtEndChange,
        onListMetricsChange,
        onManualNavigation,
        onTimelineDataChange,
        goToBottom,
        scrollToBottomOnSend,
        restoreSnapshot,
        isPinned,
        isFollowingProgrammatically,
        showScrollButton,
        userOwnsScroll,
        nearContentStart,
    } = useChatTimelineScroll({
        currentSessionId,
        currentSessionKey,
        composerOverlayHeight,
        messageListRef,
        loadHistoryUntilMessage,
        checkLinkedMessage,
        onLinkedMessageMissing: handleLinkedMessageMissing,
        sessionIsWorking,
        revealGate,
        onActiveTurnChange: handleActiveTurnChange,
    });

    // ── in-conversation search ──────────────────────────────────────────────
    // Cmd+F belongs to whatever has focus: the editor keeps its own search,
    // the chat (its composer, or nothing focused after clicking its text)
    // opens this bar. With several chat columns on screen, an unfocused
    // Cmd+F goes to the column the pointer last pressed in. Search is opt-in;
    // while it is off the shortcut is left alone. VS Code has no OpenChamber
    // server and so no index to search.
    const chatRootRef = React.useRef<HTMLDivElement>(null);
    const lastPressedInsideRef = React.useRef(false);
    const [chatSearch, setChatSearch] = React.useState({ open: false, focusRequest: 0 });
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const messageSearchEnabled = useUIStore((state) => state.messageSearchEnabled);
    React.useEffect(() => {
        if (!active || !currentSessionId || !messageSearchEnabled || isVSCodeRuntime()) return;
        const combo = getEffectiveShortcutCombo('find_in_file', shortcutOverrides);
        const onPointerDown = (event: PointerEvent) => {
            // SAFETY: a pointer event target inside the document is a Node.
            lastPressedInsideRef.current = Boolean(chatRootRef.current?.contains(event.target as Node));
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || !eventMatchesShortcut(event, combo)) return;
            const root = chatRootRef.current;
            const focused = document.activeElement;
            const unfocused = !focused || focused === document.body;
            if (!root || (unfocused ? !lastPressedInsideRef.current : !root.contains(focused))) return;
            event.preventDefault();
            setChatSearch((current) => ({ open: true, focusRequest: current.focusRequest + 1 }));
        };
        document.addEventListener('pointerdown', onPointerDown, { capture: true });
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, { capture: true });
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [active, currentSessionId, messageSearchEnabled, shortcutOverrides]);
    // The search belongs to the conversation it was opened in.
    React.useEffect(() => {
        setChatSearch((current) => (current.open ? { ...current, open: false } : current));
    }, [currentSessionId]);
    const closeChatSearch = React.useCallback(() => {
        setChatSearch((current) => ({ ...current, open: false }));
    }, []);

    // A subagent report opens a turn of its own at the end of the chat only for
    // a `subagent: true` command; a call's report finishes that call's row
    // (see `ToolPart`), and a run started before the loaded history stays in
    // the session's subagent list, so the chat never shifts for either.
    const sessionStartTimes = useSessionStartTimes(effectiveSessionDirectory);
    const viewportMessages = React.useMemo(
        () => keepCommandSubagentReports(sessionMessages, (childSessionID) => sessionStartTimes.get(childSessionID)),
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
    }, [timelineController.handleActiveTurnChange]);
    // Assigned during render: the entry restore runs in a layout effect of
    // this same commit, before passive effects could update the ref.
    const controllerLoadHistoryUntilMessage = timelineController.loadHistoryUntilMessage;
    loadHistoryUntilMessageRef.current = (messageId, maxBatches) => controllerLoadHistoryUntilMessage(messageId, { maxBatches });
    const chatQuoteHighlights = useChatQuoteHighlightStore();

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
    // The mini chat window is too narrow for the navigator's panel.
    const showPromptNavigator = !isMobile
        && chatSurfaceMode !== 'mini-chat'
        && !isDesktopExpandedInput
        && promptNavigatorEnabled
        && timelineController.turnIds.length >= 2;

    React.useEffect(() => {
        if (!showPromptNavigator && !pinned) {
            useUIStore.getState().setPromptNavigatorPanelOpen(false);
        }
    }, [pinned, showPromptNavigator]);

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

    const lastScrolledSessionKeyRef = React.useRef<string | null>(null);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasRenderableSessionSnapshot;
    const retrySessionLoad = React.useCallback(() => {
        if (!active || !currentSessionId) return;
        void sync.ensureSessionRenderable(currentSessionId, true, effectiveSessionDirectory);
    }, [currentSessionId, effectiveSessionDirectory, active, sync]);

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
        if (!active || !currentSessionId) return;
        if (hasRenderableSessionSnapshot || spaceStopped) return;
        void ensureSessionRenderable(currentSessionId);
    }, [currentSessionId, ensureSessionRenderable, hasRenderableSessionSnapshot, active, spaceStopped]);

    // A space that runs again answers the load the chat held, or the one that failed while it
    // was going down: the user waiting on its start sees the chat without a retry.
    const wasSpaceStoppedRef = React.useRef(spaceStopped);
    React.useEffect(() => {
        const wasStopped = wasSpaceStoppedRef.current;
        wasSpaceStoppedRef.current = spaceStopped;
        if (wasStopped && !spaceStopped && !hasRenderableSessionSnapshot) retrySessionLoad();
    }, [hasRenderableSessionSnapshot, retrySessionLoad, spaceStopped]);

    const composerSlotRef = React.useRef<HTMLDivElement | null>(null);
    // The slot mounts after the first commit (behind the session gate), so
    // the inset observer keys on the node itself rather than on mount.
    const [composerSlotNode, setComposerSlotNode] = React.useState<HTMLDivElement | null>(null);
    const attachComposerSlot = React.useCallback((node: HTMLDivElement | null) => {
        composerSlotRef.current = node;
        setComposerSlotNode(node);
    }, []);
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
    // The composer floats over the transcript in a normal session view; the
    // draft screen (centred composer) and the expanded editor keep it in flow.
    // On mobile the keyboard choreography still moves the form inside the
    // slot and shrinks the column around it, so the slot rides along unchanged.
    const floatingComposer = !draftLayoutVisible && !isDesktopExpandedInput;
    // The slot's height is published as `--chat-composer-inset` (the end fade
    // reads it) and the list footer's tail spacer reads
    // `--chat-composer-tail-inset` (see composerTailInset: a composer that
    // grows takes the gap above it before it pushes the transcript). Both are
    // written straight from the observer so composer growth never re-renders
    // the timeline, and onto the reading elements, not the column: inherited
    // from the column, every new composer line restyled the whole transcript
    // (composerInsetReaders). While the composer is taller than at rest,
    // `data-composer-grown` on the column hides the recap hint, which lies
    // in the gap under the latest answer the composer then grows into.
    React.useLayoutEffect(() => {
        const slot = composerSlotNode;
        const column = slot?.parentElement;
        if (!floatingComposer || !slot || !column || !globalThis.ResizeObserver) return;
        const update = () => {
            const height = Math.round(slot.getBoundingClientRect().height);
            // Only the composer itself at its natural height can set the
            // resting height. What stands in for it (a subagent's read-only
            // banner, the mobile comment composer: data-composer-transient)
            // and a slot the pill morph pins for its tween (an inline height,
            // measured with the keyboard's padding) are shorter, and kept as
            // the floor they left the composer "grown" (recap hidden) until a
            // reload.
            const transient = slot.style.height !== '' || slot.querySelector('[data-composer-transient]') !== null;
            const { tailInset, grown } = recordComposerSlotHeight(column, height, !transient);
            publishComposerInsets(column, { inset: height, tailInset });
            column.toggleAttribute('data-composer-grown', grown);
        };
        const observer = new ResizeObserver(update);
        observer.observe(slot);
        update();
        return () => {
            observer.disconnect();
            forgetComposerSlot(column);
            withdrawComposerInsets(column);
            column.removeAttribute('data-composer-grown');
        };
    }, [composerSlotNode, floatingComposer]);
    // The list owns the scroll element, so the shadows and the load-older
    // trigger bind to its node rather than to a wrapper we render.
    const scrollNodeRef = React.useMemo(() => ({ current: scrollNode }), [scrollNode]);
    useScrollShadow(scrollNodeRef, {
        observeMutations: false,
        hideTopShadow: isMobile && stickyUserHeader,
        // The glass composer is the visible end of the transcript.
        hideBottomShadow: floatingComposer,
    });

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

    const sessionPlaceholder = (() => {
        if (draftOpen || draftPresentationExiting) {
            if (!useCompactDraftLayout || isDesktopExpandedInput) {
                return null;
            }
            return <DraftWelcome exiting={draftPresentationExiting} />;
        }

        const showHydrationSkeleton = isSessionHydrating && sessionMessages.length === 0 && !sessionIsWorking;
        if (showHydrationSkeleton) {
            if (spaceStopped && effectiveSessionDirectory) {
                return <SpaceChatPlaceholder directory={effectiveSessionDirectory} />;
            }
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
                        <HydrationSkeleton waiting={!isDesktopExpandedInput} />
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

        return undefined;
    })();

    const sessionSurface = (
        <ChatViewport
            placeholder={sessionPlaceholder}
            currentSessionId={currentSessionId ?? ''}
            currentSessionKey={currentSessionKey ?? currentSessionId ?? ''}
            isDesktopExpandedInput={isDesktopExpandedInput}
            isMobile={isMobile}
            floatingComposer={floatingComposer}
            statusRowClearance={sessionIsWorking ? composerOverlayHeight : 0}
            directory={effectiveSessionDirectory}
            scrollRef={scrollRef}
            registerList={registerList}
            onIsAtEndChange={onIsAtEndChange}
            onListMetricsChange={onListMetricsChange}
            onTimelineDataChange={onTimelineDataChange}
            messageListRef={messageListRef}
            renderedMessages={timelineController.renderedMessages}
            isLoadingOlder={timelineController.isLoadingOlder}
            sessionIsWorking={sessionIsWorking}
            streamingMessageId={streamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            retryOverlay={retryOverlay}
            scrollToBottom={resumeToLatestInstant}
            onScrollbarDrag={onManualNavigation}
            endPinningReleased={userOwnsScroll}
            revealWaited={revealWaited}
            revealGate={revealGate}
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

	return (
		<div
			ref={attachColumnRoot}
			// App-wide handlers (double Escape to stop) find the pinned
			// column's session and whether it runs here.
			data-chat-column={pinned ? 'pinned' : 'main'}
			data-chat-session-id={pinned ? currentSessionId ?? undefined : undefined}
			data-chat-working={pinned && sessionIsWorking ? 'true' : undefined}
			className="flex h-full min-h-0 bg-background"
		>
		<ChatColumnSessionContext.Provider value={chatColumnSession}>
		<ChatColumnActionsContext.Provider value={columnActions}>
		{/* One mobile comment controller per column: selections in this column
		    comment into this column's composer, never a sibling's. */}
		<MobileCommentComposerContext.Provider value={mobileCommentComposer}>
		<ChatQuoteHighlightContext.Provider value={chatQuoteHighlights}>
		<ChatQuoteHighlightLayer
			store={chatQuoteHighlights}
			scrollNode={scrollNode}
			scrollToMessage={timelineController.scrollToMessage}
		/>
		<div
			ref={chatRootRef}
			data-composer-bound
			// A live reply can outrun the follow glide; while it streams and the
			// view follows it (no scroll-to-bottom pill, no reader gesture), the
			// transcript fades out above the composer (index.css). Once the
			// reader leaves the end, the rows slide under its glass again.
			data-live-tail={sessionStatusForCurrent.type === 'busy' && isFollowingProgrammatically ? 'true' : undefined}
			className="relative flex min-w-0 flex-1 flex-col h-full bg-background"
		>
			{returnToParentButton}
			{sessionSurface}
			{chatSearch.open && currentSessionId && messageSearchEnabled ? (
				<div className="pointer-events-none absolute inset-e-3 top-2 z-20">
					<ChatSearchBar
						sessionId={currentSessionId}
						scrollNode={scrollNode}
						focusRequest={chatSearch.focusRequest}
						onClose={closeChatSearch}
					/>
				</div>
			) : null}

            <div
                ref={attachComposerSlot}
                // The mobile pill morph pins a floating slot for its tween.
                data-composer-slot={floatingComposer ? 'floating' : 'flow'}
                className={cn(
                    'z-10 flex min-h-0',
                    floatingComposer
                        ? 'absolute inset-x-0 bottom-0'
                        : 'relative',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : draftLayoutVisible && !useCompactDraftLayout
                            ? 'flex-1 items-center justify-center bg-background pb-[6vh]'
                        : !floatingComposer && 'bg-background'
                )}
            >
                {!draftLayoutVisible && !isDesktopExpandedInput && sessionMessages.length > 0 && (
                    /* One zero-height anchor on the slot's top edge for
                       everything that floats above the composer, so the
                       mobile keyboard slide and the pill morph move them as
                       one rider with the box instead of leaving them to jump
                       when the slot resizes (see mobileComposerMorph). */
                    <div className="oc-composer-riders absolute bottom-full inset-x-0" data-composer-riders="true">
                        <ScrollToBottomButton
                            visible={timelineController.showScrollToBottom}
                            working={sessionIsWorking}
                            onClick={navigation.resumeToLatest}
                        />
                        {/* Same anchor and column as the pill, so the status
                            row and the pill it hands off to share the exact
                            distance from the input and the same left edge. */}
                        <div
                            ref={registerFloatingPanelClearanceReader}
                            className={cn(
                                'pointer-events-none absolute bottom-full inset-x-0 mb-2 transition-opacity duration-100',
                                userOwnsScroll && 'opacity-0',
                            )}
                            style={{ transform: 'translateY(calc(-1 * var(--chat-floating-panel-clearance, 0px)))' }}
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
                    </div>
                )}
                {promptReadOnly ? (
                    <>
                        {/* The docks live inside ChatInput, which a read-only
                            chat does not mount. A subagent still asks for
                            permissions and answers, and they must be answerable
                            where the user is looking; the parent shows the same
                            requests, and answering one clears it in both. */}
                        <PermissionDock
                            sessionId={currentSessionId}
                            directory={effectiveSessionDirectory}
                            hidden={false}
                        />
                        <FormDock
                            sessionId={currentSessionId}
                            directory={effectiveSessionDirectory}
                            hidden={sessionPermissions.length > 0}
                        />
                        <ReadOnlyPromptBanner
                            text={spaceArchive
                                ? t('spaces.archive.readOnlyBanner', { name: spaceArchive.name })
                                : t('chat.container.readOnlySubagentPromptBanner')}
                            onStop={!spaceArchive && currentSessionId && sessionStatusForCurrent.type !== 'idle'
                                ? () => void abortCurrentOperation(currentSessionId)
                                : undefined}
                            stopLabel={t('chat.chatInput.actions.stopGeneratingAria')}
                        />
                    </>
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
        </ChatQuoteHighlightContext.Provider>
        </MobileCommentComposerContext.Provider>
        </ChatColumnActionsContext.Provider>
        </ChatColumnSessionContext.Provider>
        {/* Kept mounted while it could ever show, so it can fade out and back
            in; `visible` drives that, `reserved` keeps its column in the right
            slot while the context panel covers it, and `besidePanel` keeps it
            beside the open panel. */}
        {workStatusPanelMountable && workStatusHost ? createPortal(
            <WorkStatusPanel
                visible={showWorkStatusPanel}
                reserved={workStatusReserved}
                besidePanel={workStatusRoomyBesidePanel}
                sessionId={currentSessionId ?? null}
                directory={workStatusDirectory ?? null}
                repositoryEnabled={!isManagedChatContext}
            />,
            workStatusHost,
        ) : null}
        </div>
    );
};
