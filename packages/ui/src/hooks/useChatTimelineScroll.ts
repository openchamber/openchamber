import React from 'react';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import { cancelWhenLayoutSettled, isLayoutAnimating, onLayoutAnimationStart, onWidthDragStart, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { createKeyboardFollowGlide, type KeyboardFollowGlide } from '@/components/chat/lib/scroll/keyboardFollowGlide';
import { createFollowGlide, type FollowGlide } from '@/components/chat/lib/scroll/followGlide';
import { retireScrollContent } from '@/components/chat/lib/scroll/retireScrollContent';
import {
    ANCHOR_HOLD_MAX_FRAMES,
    ANCHOR_HOLD_STABLE_FRAMES,
    captureMessageViewportAnchor,
    messageLinkOffsetTop,
    type MessageViewportAnchor,
    type ViewportAnchorAlignment,
} from '@/components/chat/lib/scroll/messageViewportAnchor';
import { readSessionScrollPosition, rememberOutgoingSessionScrollPosition } from '@/components/chat/lib/scroll/sessionScrollMemory';
import {
    isWaitingPageRevealPending,
    pendingWaitingPageID,
    releaseWaitingPageRevealOutside,
    subscribeRequestReveal,
    takeWaitingPageReveal,
} from '@/sync/request-reveal';
import {
    peekMessageFocus,
    releaseMessageFocusOutside,
    settleMessageFocus,
    subscribeMessageFocus,
    markMessageFocusShown,
    type MessageFocusRequest,
} from '@/lib/router/messageFocus';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useUIStore } from '@/stores/useUIStore';
import type { TimelineRevealGate } from '@/components/chat/timelineRevealGate';
import {
    getRowBottom,
    resolveRealContentEndOffset,
    resolveTimelineIsAtEnd,
    TIMELINE_FOLLOW_REARM_THRESHOLD_PX,
    type TimelineListMeasurementState,
    type TimelineScrollMode,
} from '@/components/chat/lib/scroll/timelineScrollAnchoring';
import {
    resolveFollowGlideTarget,
    resolveFollowStop,
    resolvePageRevealTarget,
} from '@/components/chat/lib/scroll/followScroll';
import {
    isFollowReleaseKey,
    isMiddleButtonPan,
    nestedScrollableConsumesWheelUp,
    onFrameScroll,
    dispatchPageWaiting,
    findWaitingPage,
    onPageWaiting,
    onRowExpand,
    onTabStep,
} from '@/components/chat/lib/scroll/timelineScrollIntent';

export interface TimelineListHandle {
    getState: () => TimelineListMeasurementState & {
        readonly scroll: number;
        readonly contentLength?: number;
        readonly listen?: (
            listenerType: 'totalSize',
            callback: (value: number) => void,
        ) => () => void;
    };
    getScrollableNode: () => HTMLElement | null;
    scrollToEnd: (options?: { animated?: boolean }) => unknown;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => unknown;
    scrollToIndex: (params: {
        index: number;
        animated?: boolean;
        viewPosition?: number;
        viewOffset?: number;
    }) => unknown;
}

export type LinkedMessageState = 'exists' | 'missing' | 'unknown';

interface TimelineAnchorHandle {
    alignViewportAnchor: (anchor: MessageViewportAnchor) => ViewportAnchorAlignment;
}

interface UseChatTimelineScrollOptions {
    currentSessionId: string | null;
    currentSessionKey: string | null;
    composerOverlayHeight: number;
    messageListRef: React.RefObject<TimelineAnchorHandle | null>;
    loadHistoryUntilMessage?: (messageId: string, maxBatches: number) => Promise<boolean>;
    checkLinkedMessage?: (messageId: string) => Promise<LinkedMessageState>;
    onLinkedMessageMissing?: () => void;
    sessionIsWorking: boolean;
    pinned?: boolean;
    revealGate?: TimelineRevealGate | null;
    onActiveTurnChange?: (turnId: string | null) => void;
}

interface UseChatTimelineScrollResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    scrollNode: HTMLDivElement | null;
    isPinned: boolean;
    registerList: (list: TimelineListHandle | null, sessionKey?: string) => void;
    captureOutgoingPosition: () => void;
    onIsAtEndChange: (isAtEnd: boolean) => void;
    onListMetricsChange: (metrics: { readonly headerSize: number; readonly footerSize: number }) => void;
    onManualNavigation: () => void;
    takeViewport: () => void;
    onTimelineDataChange: () => void;
    showScrollButton: boolean;
    userOwnsScroll: boolean;
    nearContentStart: boolean;
    isFollowingProgrammatically: boolean;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    scrollToBottomOnSend: () => void;
    restoreSnapshot: () => Promise<boolean>;
}

const SHOW_SCROLL_BUTTON_DELAY_MS = 150;
const ANIMATION_END_CORRECTION_MAX_PX = 64;
const REMEMBERED_POSITION_REVEAL_WAIT_MS = 800;
const REMEMBERED_POSITION_HISTORY_BATCHES = 3;
const MESSAGE_LINK_HIGHLIGHT_MS = 1200;
const REPLY_START_GAP_PX = 16;
const SEND_GLIDE_WINDOW_MS = 2000;
const TURN_END_GLIDE_WINDOW_MS = 1000;
const LOAD_OLDER_REACH_VIEWPORTS = 2;
const PAGE_REVEAL_SETTLE_MS = 1500;
const FOLLOW_LANDING_SNAP_MAX_PX = 4;

let reducedMotionQuery: MediaQueryList | null | undefined;
const prefersReducedMotion = (): boolean => {
    if (reducedMotionQuery === undefined) {
        const browserWindow = globalThis.window;
        reducedMotionQuery = browserWindow?.matchMedia
            ? browserWindow.matchMedia('(prefers-reduced-motion: reduce)')
            : null;
    }
    return reducedMotionQuery?.matches === true;
};
const followScrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');
const drawsScrollInWholePixels = (): boolean => (
    globalThis.CSS?.supports?.('-webkit-touch-callout', 'none') === true
);

const lastMatch = (node: HTMLElement, selector: string): HTMLElement | null => {
    const matches = node.querySelectorAll<HTMLElement>(selector);
    return matches[matches.length - 1] ?? null;
};

interface FollowStop {
    readonly element: HTMLElement;
    readonly limit: number;
    readonly bottom: number;
}

const turnIdOf = (element: HTMLElement): string | undefined => (
    element.closest<HTMLElement>('[data-turn-row]')?.dataset.turnRow
        ?? element.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId
);

const readFollowStop = (node: HTMLElement, element: HTMLElement): FollowStop => {
    const rect = element.getBoundingClientRect();
    const offset = node.scrollTop - node.getBoundingClientRect().top;
    const turnId = turnIdOf(element);
    const header = turnId
        ? node.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"] > [data-turn-sticky-header]`)
        : null;
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    return {
        element,
        limit: Math.max(0, rect.top + offset - headerHeight - REPLY_START_GAP_PX),
        bottom: rect.bottom + offset,
    };
};

const findLatestTurnId = (node: HTMLElement): string | undefined => {
    let latest: HTMLElement | null = null;
    let latestTop = Number.NEGATIVE_INFINITY;
    for (const row of node.querySelectorAll<HTMLElement>('[data-turn-id], [data-turn-row]')) {
        const top = row.getBoundingClientRect().top;
        if (top > latestTop) {
            latest = row;
            latestTop = top;
        }
    }
    return latest ? turnIdOf(latest) : undefined;
};

const findStreamingReply = (node: HTMLElement): HTMLElement | null => lastMatch(node, '[data-streaming-reply]');

const findFollowStops = (node: HTMLElement, stopAfterUserMessage: boolean, reply: HTMLElement | null): FollowStop[] => {
    const stops: FollowStop[] = [];
    const turnId = stopAfterUserMessage ? findLatestTurnId(node) : undefined;
    let work: HTMLElement | null = null;
    let workBottom = Number.NEGATIVE_INFINITY;
    if (turnId) {
        for (const row of node.querySelectorAll<HTMLElement>(`[data-turn-row="${CSS.escape(turnId)}"]`)) {
            const rect = row.getBoundingClientRect();
            if (!work || rect.top < work.getBoundingClientRect().top) work = row;
            workBottom = Math.max(workBottom, rect.bottom);
        }
    }
    if (work) {
        const stop = readFollowStop(node, work);
        stops.push({ ...stop, bottom: workBottom + node.scrollTop - node.getBoundingClientRect().top });
    }
    if (reply) stops.push(readFollowStop(node, reply));
    return stops;
};

type PositionTarget =
    | { readonly kind: 'remembered'; readonly anchor: MessageViewportAnchor }
    | { readonly kind: 'link'; readonly anchor: MessageViewportAnchor; readonly request: MessageFocusRequest };

const linkTarget = (request: MessageFocusRequest, node: HTMLElement): PositionTarget => ({
    kind: 'link',
    request,
    anchor: { messageId: request.messageId, offsetTop: messageLinkOffsetTop(node) },
});

const highlightLinkedMessage = (node: HTMLElement, messageId: string): void => {
    const element = node.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!element) return;
    element.setAttribute('data-message-link-target', '');
    window.setTimeout(() => element.removeAttribute('data-message-link-target'), MESSAGE_LINK_HIGHLIGHT_MS);
};

export const useChatTimelineScroll = ({
    currentSessionId,
    currentSessionKey,
    composerOverlayHeight,
    messageListRef,
    loadHistoryUntilMessage,
    checkLinkedMessage,
    onLinkedMessageMissing,
    sessionIsWorking,
    pinned = false,
    revealGate = null,
    onActiveTurnChange,
}: UseChatTimelineScrollOptions): UseChatTimelineScrollResult => {
    const sessionIsWorkingRef = React.useRef(sessionIsWorking);
    sessionIsWorkingRef.current = sessionIsWorking;
    const sendGlideUntilRef = React.useRef(0);
    const turnEndGlideUntilRef = React.useRef(0);
    const workingSessionRef = React.useRef({ key: currentSessionKey, working: sessionIsWorking });
    React.useLayoutEffect(() => {
        const previous = workingSessionRef.current;
        workingSessionRef.current = { key: currentSessionKey, working: sessionIsWorking };
        if (previous.key !== currentSessionKey) {
            turnEndGlideUntilRef.current = 0;
        } else if (previous.working && !sessionIsWorking) {
            turnEndGlideUntilRef.current = performance.now() + TURN_END_GLIDE_WINDOW_MS;
        }
    }, [currentSessionKey, sessionIsWorking]);
    const isTurnRunning = () => sessionIsWorkingRef.current || performance.now() < sendGlideUntilRef.current;
    const isLive = () => isTurnRunning() || performance.now() < turnEndGlideUntilRef.current;
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const listRef = React.useRef<TimelineListHandle | null>(null);

    const [scrollNode, setScrollNode] = React.useState<HTMLDivElement | null>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [isPinned, setIsPinned] = React.useState(true);
    const [isFollowingProgrammatically, setIsFollowingProgrammatically] = React.useState(false);
    const [userOwnsScroll, setUserOwnsScroll] = React.useState(false);
    const [nearContentStart, setNearContentStart] = React.useState(true);
    const userOwnsScrollRef = React.useRef(userOwnsScroll);
    userOwnsScrollRef.current = userOwnsScroll;

    const modeRef = React.useRef<TimelineScrollMode>('following-end');
    const isAtEndRef = React.useRef(true);
    const pinnedThroughAnimationRef = React.useRef(false);
    const animationEndCorrectionRef = React.useRef(0);
    const userGenerationRef = React.useRef(0);
    const liveFollowGenerationRef = React.useRef<number | null>(0);
    const showButtonTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const composerOverlayHeightRef = React.useRef(composerOverlayHeight);
    composerOverlayHeightRef.current = composerOverlayHeight;
    const followGlideRef = React.useRef<KeyboardFollowGlide | null>(null);
    const followGlideHeld = () => followGlideRef.current?.isHeld() === true;
    const liveGlideRef = React.useRef<FollowGlide | null>(null);
    const activityRenderMode = useUIStore((state) => state.activityRenderMode);
    const stopAfterUserMessageRef = React.useRef(activityRenderMode !== 'summary');
    stopAfterUserMessageRef.current = activityRenderMode !== 'summary';
    const followStopEligibilityRef = React.useRef(new WeakMap<HTMLElement, boolean>());
    const followStoppedAtGenerationRef = React.useRef<number | null>(null);
    const rowExpandReleaseRef = React.useRef<{ generation: number; grew: boolean } | null>(null);
    const revealedPagesRef = React.useRef(new Set<string>());
    const pageRevealRef = React.useRef<{ pageId: string | null; block: HTMLElement; generation: number; until: number } | null>(null);
    const lastStreamingReplyRef = React.useRef<HTMLElement | null>(null);
    const resolveReplyStop = (node: HTMLElement): HTMLElement | null => {
        const reply = findStreamingReply(node);
        const ended = lastStreamingReplyRef.current;
        return reply ?? (ended?.isConnected ? ended : null);
    };
    const retireFollowStops = () => {
        const node = scrollRef.current;
        if (!node) return;
        for (const stop of findFollowStops(node, stopAfterUserMessageRef.current, resolveReplyStop(node))) {
            followStopEligibilityRef.current.set(stop.element, false);
        }
    };
    const listHeaderSizeRef = React.useRef(0);
    const listFooterSizeRef = React.useRef(0);
    const onListMetricsChange = React.useCallback((metrics: { readonly headerSize: number; readonly footerSize: number }) => {
        listHeaderSizeRef.current = Number.isFinite(metrics.headerSize) ? metrics.headerSize : 0;
        listFooterSizeRef.current = Number.isFinite(metrics.footerSize) ? metrics.footerSize : 0;
    }, []);
    const currentSessionKeyRef = React.useRef(currentSessionKey);
    currentSessionKeyRef.current = currentSessionKey;
    const loadHistoryUntilMessageRef = React.useRef(loadHistoryUntilMessage);
    loadHistoryUntilMessageRef.current = loadHistoryUntilMessage;
    const onLinkedMessageMissingRef = React.useRef(onLinkedMessageMissing);
    onLinkedMessageMissingRef.current = onLinkedMessageMissing;
    const checkLinkedMessageRef = React.useRef(checkLinkedMessage);
    checkLinkedMessageRef.current = checkLinkedMessage;
    const currentSessionIdRef = React.useRef(currentSessionId);
    currentSessionIdRef.current = currentSessionId;

    const cancelShowButtonTimer = React.useCallback(() => {
        if (showButtonTimerRef.current !== null) {
            clearTimeout(showButtonTimerRef.current);
            showButtonTimerRef.current = null;
        }
    }, []);

    const hideScrollButton = React.useCallback(() => {
        cancelShowButtonTimer();
        setShowScrollButton(false);
    }, [cancelShowButtonTimer]);

    const scheduleShowScrollButton = React.useCallback(() => {
        if (showButtonTimerRef.current !== null) return;
        showButtonTimerRef.current = setTimeout(() => {
            showButtonTimerRef.current = null;
            setShowScrollButton(true);
        }, SHOW_SCROLL_BUTTON_DELAY_MS);
    }, []);

    const onManualNavigation = React.useCallback(() => {
        userGenerationRef.current += 1;
        modeRef.current = 'free-scrolling';
        liveFollowGenerationRef.current = null;
        liveGlideRef.current?.stop();
        setUserOwnsScroll(true);
        const linkRequest = peekMessageFocus(currentSessionIdRef.current);
        if (linkRequest) settleMessageFocus(linkRequest);
        const listState = listRef.current?.getState();
        const atEndNow = (listState ? resolveTimelineIsAtEnd(listState) : undefined) ?? isAtEndRef.current;
        isAtEndRef.current = atEndNow;
        if (!atEndNow) {
            cancelShowButtonTimer();
            setShowScrollButton(true);
        }
    }, [cancelShowButtonTimer]);

    const isLiveFollowActive = React.useCallback(() => (
        liveFollowGenerationRef.current === userGenerationRef.current
    ), []);

    const listSessionKeyRef = React.useRef<string | null>(null);
    const restoreRef = React.useRef<{ cancel: () => void } | null>(null);
    const restoredEntryKeyRef = React.useRef<string | null>(null);
    const handledEntryKeyRef = React.useRef<string | null>(null);
    const linkServedRef = React.useRef<{ key: string; serial: number } | null>(null);

    const takeViewport = React.useCallback(() => { restoreRef.current?.cancel(); onManualNavigation(); }, [onManualNavigation]);

    const rememberOutgoingPosition = React.useCallback((node: HTMLElement, list: TimelineListHandle | null) => {
        const sessionKey = listSessionKeyRef.current;
        if (!sessionKey || handledEntryKeyRef.current !== sessionKey || restoreRef.current) return;
        const state = list?.getState();
        if (!state || state.scrollLength <= 0) return;
        // external: #6045 an unknown at-end answer must not clear the saved reading position.
        const atEnd = (modeRef.current === 'following-end' && isAtEndRef.current)
            || resolveTimelineIsAtEnd(state) === true;
        rememberOutgoingSessionScrollPosition(
            sessionKey,
            atEnd,
            atEnd ? null : captureMessageViewportAnchor(node),
        );
    }, []);

    const captureOutgoingPosition = React.useCallback(() => {
        if (scrollRef.current) rememberOutgoingPosition(scrollRef.current, listRef.current);
    }, [rememberOutgoingPosition]);

    const goToBottomReassertTimersRef = React.useRef<Array<ReturnType<typeof setTimeout>>>([]);
    const clearGoToBottomReasserts = React.useCallback(() => {
        for (const timer of goToBottomReassertTimersRef.current) clearTimeout(timer);
        goToBottomReassertTimersRef.current = [];
    }, []);

    const resumeFollow = React.useCallback((passStops: boolean) => {
        isAtEndRef.current = true;
        setIsPinned(true);
        setUserOwnsScroll(false);
        modeRef.current = 'following-end';
        liveFollowGenerationRef.current = userGenerationRef.current;
        if (passStops) retireFollowStops();
        followStoppedAtGenerationRef.current = null;
        hideScrollButton();
    }, [hideScrollButton]);
    const jumpToEnd = React.useCallback((mode: 'instant' | 'smooth', passStops: boolean) => {
        resumeFollow(passStops);
        pageRevealRef.current = null;
        liveGlideRef.current?.stop();
        void listRef.current?.scrollToEnd({ animated: mode === 'smooth' });
        clearGoToBottomReasserts();
        const generation = userGenerationRef.current;
        for (const delay of [150, 400, 800]) {
            goToBottomReassertTimersRef.current.push(setTimeout(() => {
                if (userGenerationRef.current !== generation) return;
                if (modeRef.current !== 'following-end') return;
                const state = listRef.current?.getState();
                if (state && resolveTimelineIsAtEnd(state) === true) return;
                void listRef.current?.scrollToEnd({ animated: false });
            }, delay));
        }
    }, [clearGoToBottomReasserts, resumeFollow]);

    const goToBottom = React.useCallback((mode: 'instant' | 'smooth' = 'instant') => {
        jumpToEnd(mode, !isLiveFollowActive());
    }, [isLiveFollowActive, jumpToEnd]);

    const streamingAutoFollowEnabled = useUIStore((state) => state.streamingAutoFollowEnabled);
    const streamingAutoFollowEnabledRef = React.useRef(streamingAutoFollowEnabled);
    streamingAutoFollowEnabledRef.current = streamingAutoFollowEnabled;

    const followEndRef = React.useRef<() => void>(() => {});

    const scrollToBottomOnSend = React.useCallback(() => {
        if (!streamingAutoFollowEnabledRef.current && !isAtEndRef.current) return;
        restoreRef.current?.cancel();
        retireFollowStops();
        lastStreamingReplyRef.current = null;
        if (streamingAutoFollowEnabledRef.current) {
            sendGlideUntilRef.current = performance.now() + SEND_GLIDE_WINDOW_MS;
            if (modeRef.current === 'following-end' && isAtEndRef.current && isLiveFollowActive()) {
                followEndRef.current();
                return;
            }
        }
        jumpToEnd('instant', false);
    }, [isLiveFollowActive, jumpToEnd]);

    const holdRememberedPosition = React.useCallback(() => {
        clearGoToBottomReasserts();
        modeRef.current = 'free-scrolling';
        liveFollowGenerationRef.current = null;
        liveGlideRef.current?.stop();
        isAtEndRef.current = false;
        userOwnsScrollRef.current = true;
        setIsPinned(false);
        setUserOwnsScroll(true);
        cancelShowButtonTimer();
        setShowScrollButton(true);
    }, [cancelShowButtonTimer, clearGoToBottomReasserts]);

    const settleLinkTarget = React.useCallback((target: PositionTarget) => {
        if (target.kind !== 'link') return;
        settleMessageFocus(target.request);
        linkServedRef.current = null;
    }, []);

    const startPositionRestore = React.useCallback((
        target: PositionTarget,
        node: HTMLElement,
        releaseReveal: (() => void) | null,
    ): boolean => {
        const { anchor } = target;
        const first = messageListRef.current?.alignViewportAnchor(anchor) ?? 'missing';
        if (first === 'missing') return false;
        holdRememberedPosition();

        let frame: number | null = null;
        let frames = 0;
        let stable = first === 'aligned' ? 1 : 0;
        let readyStable = 0;
        let settled = false;
        let finished = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            releaseReveal?.();
            if (target.kind === 'link') {
                highlightLinkedMessage(node, anchor.messageId);
                markMessageFocusShown(target.request);
            }
        };
        const finish = () => {
            if (finished) return;
            finished = true;
            if (frame !== null) window.cancelAnimationFrame(frame);
            node.removeEventListener('wheel', onInput);
            node.removeEventListener('touchstart', onInput);
            node.removeEventListener('pointerdown', onInput);
            node.removeEventListener('keydown', onInput);
            if (restoreRef.current === restore) restoreRef.current = null;
            releaseReveal?.();
        };
        const onInput = () => {
            settleLinkTarget(target);
            finish();
        };
        const restore = { cancel: finish };
        restoreRef.current?.cancel();
        restoreRef.current = restore;
        node.addEventListener('wheel', onInput, { passive: true });
        node.addEventListener('touchstart', onInput, { passive: true });
        node.addEventListener('pointerdown', onInput, { passive: true });
        node.addEventListener('keydown', onInput);

        const step = () => {
            frame = null;
            if (finished || scrollRef.current !== node) {
                finish();
                return;
            }
            const result = messageListRef.current?.alignViewportAnchor(anchor) ?? 'missing';
            frames += 1;
            stable = result === 'aligned' ? stable + 1 : 0;
            if (stable >= 2) settle();
            const loading = node.querySelector(`[data-message-id="${CSS.escape(anchor.messageId)}"] [data-chat-quote-pending]`) !== null;
            readyStable = result === 'aligned' && !loading ? readyStable + 1 : 0;
            if (result === 'missing' || readyStable >= ANCHOR_HOLD_STABLE_FRAMES || frames >= ANCHOR_HOLD_MAX_FRAMES) {
                finish();
                return;
            }
            frame = window.requestAnimationFrame(step);
        };
        frame = window.requestAnimationFrame(step);
        return true;
    }, [holdRememberedPosition, messageListRef, settleLinkTarget]);

    const showTargetFromOlderHistory = React.useCallback((
        target: PositionTarget,
        sessionKey: string,
        gate: TimelineRevealGate | null,
    ) => {
        const isLink = target.kind === 'link';
        const reportMissing = () => {
            settleLinkTarget(target);
            onLinkedMessageMissingRef.current?.();
        };
        const loadHistoryUntil = loadHistoryUntilMessageRef.current;
        if (!loadHistoryUntil) {
            if (isLink) reportMissing();
            return;
        }
        if (!isLink && isMobileSurfaceRuntime()) return;
        const releaseReveal = gate?.hold() ?? null;
        gate?.extendCap(REMEMBERED_POSITION_REVEAL_WAIT_MS);
        const generation = userGenerationRef.current;
        let cancelled = false;
        const search = {
            cancel: () => {
                cancelled = true;
                releaseReveal?.();
            },
        };
        restoreRef.current?.cancel();
        restoreRef.current = search;
        const maxBatches = isLink ? Number.POSITIVE_INFINITY : REMEMBERED_POSITION_HISTORY_BATCHES;
        const checkLinked = isLink ? checkLinkedMessageRef.current : undefined;
        const unknown: LinkedMessageState = 'unknown';
        const existence: Promise<LinkedMessageState> = checkLinked
            ? checkLinked(target.anchor.messageId).catch(() => unknown)
            : Promise.resolve(unknown);
        void existence
            .then((state) => (cancelled || state === 'missing' ? false : loadHistoryUntil(target.anchor.messageId, maxBatches)))
            .catch(() => false)
            .then((found) => {
                if (restoreRef.current === search) restoreRef.current = null;
                const node = scrollRef.current;
                const sameSession = !cancelled
                    && currentSessionKeyRef.current === sessionKey
                    && listSessionKeyRef.current === sessionKey;
                if (!sameSession) {
                    releaseReveal?.();
                    return;
                }
                if (!found) {
                    if (isLink) reportMissing();
                    releaseReveal?.();
                    return;
                }
                if (userGenerationRef.current !== generation) {
                    settleLinkTarget(target);
                    releaseReveal?.();
                    return;
                }
                if (!node || !startPositionRestore(target, node, releaseReveal)) {
                    releaseReveal?.();
                }
            });
    }, [settleLinkTarget, startPositionRestore]);

    const showPositionTarget = React.useCallback((
        target: PositionTarget,
        node: HTMLElement,
        sessionKey: string,
        gate: TimelineRevealGate | null,
        releaseReveal: (() => void) | null,
    ): boolean => {
        if (target.kind === 'link') {
            linkServedRef.current = { key: sessionKey, serial: target.request.serial };
        }
        if (startPositionRestore(target, node, releaseReveal)) return true;
        showTargetFromOlderHistory(target, sessionKey, gate);
        return false;
    }, [showTargetFromOlderHistory, startPositionRestore]);

    const restoreSnapshot = React.useCallback(async (): Promise<boolean> => {
        const sessionKey = currentSessionKeyRef.current;
        if (!sessionKey) return false;
        if (restoredEntryKeyRef.current === sessionKey) return true;

        isAtEndRef.current = true;
        setUserOwnsScroll(false);
        modeRef.current = 'following-end';
        liveFollowGenerationRef.current = userGenerationRef.current;
        hideScrollButton();
        void listRef.current?.scrollToEnd({ animated: false });
        return false;
    }, [hideScrollButton]);

    const registerList = React.useCallback((list: TimelineListHandle | null, sessionKey?: string) => {
        if (sessionKey !== undefined) {
            if (list && sessionKey !== currentSessionKeyRef.current) return;
            if (!list && sessionKey !== listSessionKeyRef.current) return;
        }
        const previousNode = scrollRef.current;
        // SAFETY: LegendList's web renderer mounts its scroll container as a div.
        const node = (list?.getScrollableNode() as HTMLDivElement | null) ?? null;
        if (previousNode && previousNode !== node) {
            rememberOutgoingPosition(previousNode, listRef.current);
        }
        listRef.current = list;
        scrollRef.current = node;
        setScrollNode(node);
        listSessionKeyRef.current = node ? sessionKey ?? currentSessionKeyRef.current : null;
        if (previousNode && previousNode !== node) {
            retireScrollContent(previousNode, () => scrollRef.current === previousNode);
        }
    }, [rememberOutgoingPosition]);

    const applyIsAtEnd = React.useCallback((isAtEnd: boolean) => {
        if (!isAtEnd && isLiveFollowActive()) {
            hideScrollButton();
            return;
        }
        if (!isAtEnd && followGlideHeld()) return;
        if (!isAtEnd && pinnedThroughAnimationRef.current) return;
        if (isAtEndRef.current === isAtEnd) return;
        if (isAtEnd && isTurnRunning() && followStoppedAtGenerationRef.current === userGenerationRef.current) return;
        isAtEndRef.current = isAtEnd;
        setIsPinned(isAtEnd);
        if (isAtEnd) {
            modeRef.current = 'following-end';
            liveFollowGenerationRef.current = userGenerationRef.current;
            retireFollowStops();
            setUserOwnsScroll(false);
            hideScrollButton();
        } else {
            modeRef.current = 'free-scrolling';
            liveFollowGenerationRef.current = null;
            scheduleShowScrollButton();
        }
    }, [hideScrollButton, isLiveFollowActive, scheduleShowScrollButton]);

    const endArrivalPendingRef = React.useRef(false);
    const endArrivalFrameRef = React.useRef<number | null>(null);
    const endArrivalBandRef = React.useRef(0);
    const confirmEndArrived = React.useCallback((band: number) => {
        endArrivalBandRef.current = endArrivalPendingRef.current ? Math.max(endArrivalBandRef.current, band) : band;
        if (endArrivalPendingRef.current) return;
        endArrivalPendingRef.current = true;
        queueMicrotask(() => {
            if (!endArrivalPendingRef.current) return;
            endArrivalFrameRef.current = window.requestAnimationFrame(() => {
                endArrivalFrameRef.current = null;
                endArrivalPendingRef.current = false;
                if (isAtEndRef.current) return;
                const state = listRef.current?.getState();
                if (!state || state.contentLength === undefined) return;
                if (state.contentLength - state.scroll - state.scrollLength <= endArrivalBandRef.current) applyIsAtEnd(true);
            });
        });
    }, [applyIsAtEnd]);
    const onIsAtEndChange = React.useCallback((isAtEnd: boolean) => {
        if (isAtEnd && userOwnsScrollRef.current && !isAtEndRef.current && !isTurnRunning()) {
            confirmEndArrived(TIMELINE_FOLLOW_REARM_THRESHOLD_PX);
            return;
        }
        applyIsAtEnd(isAtEnd);
    }, [applyIsAtEnd, confirmEndArrived]);

    React.useEffect(() => {
        if (sessionIsWorking) return;
        if (isAtEndRef.current || followStoppedAtGenerationRef.current !== userGenerationRef.current) return;
        const state = listRef.current?.getState();
        if (state && resolveTimelineIsAtEnd(state) === true) onIsAtEndChange(true);
    }, [onIsAtEndChange, sessionIsWorking]);

    const realContentOverflowsViewport = React.useCallback((list: TimelineListHandle): boolean => {
        const state = list.getState();
        if (state.data.length === 0) return false;

        const realContentBottom = getRowBottom(state, state.data.length - 1);
        if (realContentBottom === null) return false;
        const visibleScrollLength = Math.max(0, state.scrollLength - composerOverlayHeightRef.current);
        return realContentBottom > visibleScrollLength;
    }, []);

    const widthResizingRef = React.useRef(false);
    React.useEffect(() => {
        if (!scrollNode || !globalThis.ResizeObserver) return;
        let lastWidth: number | null = null;
        let quietTimer: ReturnType<typeof setTimeout> | null = null;
        const observer = new ResizeObserver((observerEntries) => {
            const width = observerEntries[observerEntries.length - 1]?.contentRect.width;
            if (width === undefined) return;
            if (lastWidth === null) {
                lastWidth = width;
                return;
            }
            if (Math.abs(width - lastWidth) < 1) return;
            lastWidth = width;
            widthResizingRef.current = true;
            if (quietTimer !== null) clearTimeout(quietTimer);
            quietTimer = setTimeout(() => {
                quietTimer = null;
                widthResizingRef.current = false;
                if (!isAtEndRef.current) return;
                if (userOwnsScrollRef.current || modeRef.current !== 'following-end') return;
                const list = listRef.current;
                const state = list?.getState();
                const offset = state
                    ? resolveRealContentEndOffset({
                        state,
                        headerSize: listHeaderSizeRef.current,
                        footerSize: listFooterSizeRef.current,
                    })
                    : null;
                if (list && offset !== null) {
                    void list.scrollToOffset({ offset, animated: false });
                } else {
                    void list?.scrollToEnd({ animated: false });
                }
            }, 350);
        });
        observer.observe(scrollNode);
        return () => {
            observer.disconnect();
            if (quietTimer !== null) clearTimeout(quietTimer);
            widthResizingRef.current = false;
        };
    }, [scrollNode]);

    const pinEndAtRest = React.useCallback((node: HTMLElement) => {
        const end = node.scrollHeight - node.clientHeight;
        if (end - node.scrollTop <= 1) return;
        node.scrollTop = end;
    }, []);

    const followFrameRef = React.useRef<number | null>(null);
    const releaseFollowAtStop = React.useCallback(() => {
        followStoppedAtGenerationRef.current = userGenerationRef.current;
        modeRef.current = 'free-scrolling';
        liveFollowGenerationRef.current = null;
        isAtEndRef.current = false;
        userOwnsScrollRef.current = true;
        setIsPinned(false);
        setUserOwnsScroll(true);
        scheduleShowScrollButton();
    }, [scheduleShowScrollButton]);
    const followEnd = React.useCallback(() => {
        const node = scrollRef.current;
        if (!node) return;
        if (followGlideHeld()) return;
        if (!isLive()) {
            liveGlideRef.current?.stop();
            pinEndAtRest(node);
            return;
        }
        if (followFrameRef.current !== null) return;
        const frame = window.requestAnimationFrame(() => {
            if (followFrameRef.current !== frame) return;
            followFrameRef.current = null;
            if (scrollRef.current !== node || followGlideHeld()) return;
            if (!isLiveFollowActive() || modeRef.current !== 'following-end') return;
            const list = listRef.current;
            const glide = liveGlideRef.current;
            if (!glide) return;
            const state = list?.getState();
            const stateEnd = state ? Math.max(0, (state.contentLength ?? 0) - state.scrollLength) : null;
            if (state && stateEnd !== null && glide.isHeadingTo(stateEnd, state.scroll)) return;
            const viewportLength = node.clientHeight;
            const end = Math.max(0, node.scrollHeight - viewportLength);
            const scroll = node.scrollTop;
            const glideTarget = resolveFollowGlideTarget(end, scroll);
            if (glideTarget === null) {
                glide.stop();
                return;
            }
            let target = glideTarget;
            const eligibility = followStopEligibilityRef.current;
            let stopped = false;
            const streamingReply = findStreamingReply(node);
            const endedReply = lastStreamingReplyRef.current;
            lastStreamingReplyRef.current = streamingReply;
            const reply = streamingReply ?? (endedReply?.isConnected ? endedReply : null);
            const visibleLength = viewportLength - listFooterSizeRef.current;
            for (const stop of findFollowStops(node, stopAfterUserMessageRef.current, reply)) {
                if (!eligibility.has(stop.element)) eligibility.set(stop.element, scroll <= stop.limit + 1);
                if (stopped || eligibility.get(stop.element) !== true) continue;
                const held = resolveFollowStop(glideTarget, stop, visibleLength);
                if (!held.hold) continue;
                target = held.target;
                stopped = true;
                eligibility.set(stop.element, false);
                releaseFollowAtStop();
            }
            if (Math.abs(target - scroll) <= 1) {
                glide.stop();
                return;
            }
            if (target - scroll > viewportLength) node.scrollTop = target - viewportLength;
            glide.aim(target, stateEnd ?? end, prefersReducedMotion());
        });
        followFrameRef.current = frame;
    }, [isLiveFollowActive, pinEndAtRest, releaseFollowAtStop]);
    followEndRef.current = followEnd;

    const pageRevealFrameRef = React.useRef<number | null>(null);
    const revealWaitingPage = React.useCallback(() => {
        if (pageRevealRef.current === null || pageRevealFrameRef.current !== null) return;
        pageRevealFrameRef.current = window.requestAnimationFrame(() => {
            pageRevealFrameRef.current = null;
            const node = scrollRef.current;
            const reveal = pageRevealRef.current;
            if (!node || !reveal) return;
            if (reveal.generation !== userGenerationRef.current || performance.now() > reveal.until || !reveal.block.isConnected) {
                pageRevealRef.current = null;
                return;
            }
            const offset = node.scrollTop - node.getBoundingClientRect().top;
            const rect = reveal.block.getBoundingClientRect();
            const viewportLength = node.clientHeight;
            const scroll = node.scrollTop;
            const page = { top: rect.top + offset, bottom: rect.bottom + offset };
            const topGap = messageLinkOffsetTop(node);
            let target = resolvePageRevealTarget(page, scroll, viewportLength - listFooterSizeRef.current, topGap);
            if (target === null) return;
            const end = node.scrollHeight - viewportLength;
            if (end - target <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX && page.top - topGap >= end) {
                target = end;
                resumeFollow(true);
            } else if (modeRef.current === 'following-end') {
                releaseFollowAtStop();
            }
            liveGlideRef.current?.stop();
            if (Math.abs(target - scroll) > viewportLength) {
                node.scrollTop = target + (target > scroll ? -viewportLength : viewportLength);
            }
            node.scrollTo({ top: target, behavior: followScrollBehavior() });
        });
    }, [releaseFollowAtStop, resumeFollow]);
    const revealWaitingPageRef = React.useRef(revealWaitingPage);
    revealWaitingPageRef.current = revealWaitingPage;
    React.useEffect(() => () => {
        if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
        if (pageRevealFrameRef.current !== null) window.cancelAnimationFrame(pageRevealFrameRef.current);
        pageRevealFrameRef.current = null;
        if (endArrivalFrameRef.current !== null) window.cancelAnimationFrame(endArrivalFrameRef.current);
        endArrivalFrameRef.current = null;
        endArrivalPendingRef.current = false;
    }, []);

    const onTimelineDataChange = React.useCallback(() => {
        if (widthResizingRef.current) return;
        revealWaitingPage();

        if (!userOwnsScrollRef.current) {
            const list = listRef.current;
            if (list) {
                const state = list.getState();
                const lastIndex = state.data.length - 1;
                const lastBottom = lastIndex >= 0 ? getRowBottom(state, lastIndex) : null;
                if (lastBottom !== null && state.scroll > lastBottom) {
                    const offset = resolveRealContentEndOffset({
                        state,
                        headerSize: listHeaderSizeRef.current,
                        footerSize: listFooterSizeRef.current,
                    });
                    if (offset !== null) {
                        void list.scrollToOffset({ offset, animated: false });
                        return;
                    }
                }
            }
        }

        const offerEndIfLeftBehind = () => {
            const list = listRef.current;
            if (!list) return;
            const state = list.getState();
            const below = state.contentLength === undefined ? null : state.contentLength - state.scroll - state.scrollLength;
            if (!isAtEndRef.current) {
                if (below !== null && below <= 1) confirmEndArrived(1);
                return;
            }
            const opened = rowExpandReleaseRef.current;
            if (opened && opened.generation === userGenerationRef.current && below !== null) {
                if (below > 1) {
                    opened.grew = true;
                } else if (opened.grew) {
                    rowExpandReleaseRef.current = null;
                    isAtEndRef.current = false;
                    applyIsAtEnd(true);
                    return;
                }
            }
            const lastIndex = state.data.length - 1;
            const lastBottom = lastIndex >= 0 ? getRowBottom(state, lastIndex) : null;
            if (lastBottom === null) return;
            const visibleBottom = state.scroll + state.scrollLength - composerOverlayHeightRef.current;
            if (lastBottom - visibleBottom > TIMELINE_FOLLOW_REARM_THRESHOLD_PX) {
                isAtEndRef.current = false;
                setIsPinned(false);
                scheduleShowScrollButton();
            }
        };

        if (!streamingAutoFollowEnabledRef.current) {
            offerEndIfLeftBehind();
            return;
        }
        if (!isLiveFollowActive()) {
            offerEndIfLeftBehind();
            return;
        }

        if (modeRef.current !== 'following-end') return;
        followEnd();
    }, [applyIsAtEnd, confirmEndArrived, followEnd, isLiveFollowActive, revealWaitingPage, scheduleShowScrollButton]);

    const onTimelineDataChangeRef = React.useRef(onTimelineDataChange);
    onTimelineDataChangeRef.current = onTimelineDataChange;
    React.useEffect(() => {
        if (!scrollNode) return;
        const listen = listRef.current?.getState().listen;
        if (!listen) return;
        const unsubscribe = listen('totalSize', () => {
            onTimelineDataChangeRef.current();
        });
        return unsubscribe;
    }, [scrollNode]);

    const onManualNavigationRef = React.useRef(onManualNavigation);
    onManualNavigationRef.current = onManualNavigation;

    React.useEffect(() => {
        if (!scrollNode) return;

        const canScrollUp = () => {
            const list = listRef.current;
            if (!list) return false;
            if (list.getState().scroll > 1) return true;
            return realContentOverflowsViewport(list);
        };
        const gesture = () => {
            onManualNavigationRef.current();
        };
        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY < 0 && !nestedScrollableConsumesWheelUp(scrollNode, event.target) && canScrollUp()) {
                gesture();
            }
        };
        let touchLastX: number | null = null;
        let touchLastY: number | null = null;
        const handleTouchStart = (event: TouchEvent) => {
            touchLastX = event.touches[0]?.clientX ?? null;
            touchLastY = event.touches[0]?.clientY ?? null;
        };
        const handleTouchMove = (event: TouchEvent) => {
            const x = event.touches[0]?.clientX ?? null;
            const y = event.touches[0]?.clientY ?? null;
            const lastX = touchLastX;
            const lastY = touchLastY;
            touchLastX = x;
            touchLastY = y;
            if (x === null || y === null || lastX === null || lastY === null) return;
            const dx = x - lastX;
            const dy = y - lastY;
            if (Math.abs(dy) <= Math.abs(dx)) return;
            const draggedUp = dy > 0;
            if ((draggedUp || !isAtEndRef.current) && canScrollUp()) gesture();
        };
        const handleTouchEnd = () => {
            touchLastX = null;
            touchLastY = null;
        };
        const handlePointerDown = (event: PointerEvent) => {
            if (isMiddleButtonPan(scrollNode, event)) {
                if (canScrollUp()) gesture();
                return;
            }
            if ((event.target === scrollNode || !isAtEndRef.current) && canScrollUp()) gesture();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (isFollowReleaseKey(event) && canScrollUp()) gesture();
        };
        const stopFrameScroll = onFrameScroll(scrollNode, (direction) => {
            if ((direction === 'up' || !isAtEndRef.current) && canScrollUp()) gesture();
        });
        const stopRowExpand = onRowExpand(scrollNode, () => {
            if (modeRef.current !== 'following-end') return;
            gesture();
            rowExpandReleaseRef.current = { generation: userGenerationRef.current, grew: false };
            void listRef.current?.scrollToOffset({ offset: scrollNode.scrollTop, animated: false });
        });
        const stopPageWaiting = onPageWaiting(scrollNode, (block, pageId) => {
            const reveal = pageRevealRef.current;
            if (reveal?.pageId === pageId) {
                reveal.block = block;
            } else {
                if (revealedPagesRef.current.has(pageId)) return;
                revealedPagesRef.current.add(pageId);
                const following = modeRef.current === 'following-end' && isLiveFollowActive();
                const stopped = followStoppedAtGenerationRef.current === userGenerationRef.current;
                if (!streamingAutoFollowEnabledRef.current || (!following && !stopped)) return;
                pageRevealRef.current = { pageId, block, generation: userGenerationRef.current, until: performance.now() + PAGE_REVEAL_SETTLE_MS };
            }
            revealWaitingPageRef.current();
        });
        const stopTabStep = onTabStep(scrollNode, (block) => {
            void listRef.current?.scrollToOffset({ offset: scrollNode.scrollTop, animated: false });
            pageRevealRef.current = { pageId: null, block, generation: userGenerationRef.current, until: performance.now() + PAGE_REVEAL_SETTLE_MS };
            revealWaitingPageRef.current();
        });
        const handleScroll = () => {
            const scrollTop = scrollNode.scrollTop;
            const viewportLength = listRef.current?.getState().scrollLength ?? 0;
            setNearContentStart(scrollTop < viewportLength * LOAD_OLDER_REACH_VIEWPORTS);
        };

        scrollNode.addEventListener('wheel', handleWheel, { passive: true });
        scrollNode.addEventListener('touchstart', handleTouchStart, { passive: true });
        scrollNode.addEventListener('touchmove', handleTouchMove, { passive: true });
        scrollNode.addEventListener('touchend', handleTouchEnd, { passive: true });
        scrollNode.addEventListener('touchcancel', handleTouchEnd, { passive: true });
        scrollNode.addEventListener('pointerdown', handlePointerDown, { passive: true });
        scrollNode.addEventListener('keydown', handleKeyDown);
        scrollNode.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            scrollNode.removeEventListener('wheel', handleWheel);
            scrollNode.removeEventListener('touchstart', handleTouchStart);
            scrollNode.removeEventListener('touchmove', handleTouchMove);
            scrollNode.removeEventListener('touchend', handleTouchEnd);
            scrollNode.removeEventListener('touchcancel', handleTouchEnd);
            scrollNode.removeEventListener('pointerdown', handlePointerDown);
            scrollNode.removeEventListener('keydown', handleKeyDown);
            scrollNode.removeEventListener('scroll', handleScroll);
            stopFrameScroll();
            stopRowExpand();
            stopPageWaiting();
            stopTabStep();
            pageRevealRef.current = null;
        };
    }, [isLiveFollowActive, realContentOverflowsViewport, scrollNode]);

    const lastSessionKeyRef = React.useRef<string | null>(null);
    React.useLayoutEffect(() => {
        if (!currentSessionId || !currentSessionKey || currentSessionKey === lastSessionKeyRef.current) {
            return;
        }
        lastSessionKeyRef.current = currentSessionKey;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        restoreRef.current?.cancel();
        restoredEntryKeyRef.current = null;
        releaseMessageFocusOutside(currentSessionId);
        if (!pinned) releaseWaitingPageRevealOutside(currentSessionId);
        linkServedRef.current = null;
        isAtEndRef.current = true;
        setUserOwnsScroll(false);
        setNearContentStart(true);
        liveGlideRef.current?.stop();
        modeRef.current = 'following-end';
        liveFollowGenerationRef.current = userGenerationRef.current;
        followStoppedAtGenerationRef.current = null;
        hideScrollButton();
    }, [currentSessionId, currentSessionKey, hideScrollButton, pinned]);

    React.useLayoutEffect(() => {
        if (!currentSessionKey || !scrollNode) return;
        const releaseReveal = revealGate?.hold() ?? null;
        if (scrollRef.current === scrollNode && handledEntryKeyRef.current !== currentSessionKey) {
            handledEntryKeyRef.current = currentSessionKey;
            const linkRequest = peekMessageFocus(currentSessionIdRef.current);
            const remembered = !pinned && isWaitingPageRevealPending(currentSessionIdRef.current)
                ? null
                : readSessionScrollPosition(currentSessionKey);
            const target: PositionTarget | null = linkRequest
                ? linkTarget(linkRequest, scrollNode)
                : remembered ? { kind: 'remembered', anchor: remembered } : null;
            if (target && showPositionTarget(target, scrollNode, currentSessionKey, revealGate, releaseReveal)) {
                restoredEntryKeyRef.current = currentSessionKey;
                return () => releaseReveal?.();
            }
        }
        let frame: number | null = null;
        const settle = () => {
            frame = null;
            if (!userOwnsScrollRef.current && modeRef.current === 'following-end') {
                const end = scrollNode.scrollHeight - scrollNode.clientHeight;
                if (end - scrollNode.scrollTop > 1) scrollNode.scrollTop = end;
            }
            releaseReveal?.();
        };
        frame = requestAnimationFrame(settle);
        return () => {
            if (frame !== null) cancelAnimationFrame(frame);
            releaseReveal?.();
        };
    }, [currentSessionKey, pinned, revealGate, scrollNode, showPositionTarget]);

    React.useEffect(() => {
        if (!scrollNode || !currentSessionKey) return;
        const showRequested = () => {
            if (scrollRef.current !== scrollNode || handledEntryKeyRef.current !== currentSessionKey) return;
            const request = peekMessageFocus(currentSessionIdRef.current);
            if (!request) return;
            const served = linkServedRef.current;
            if (served?.key === currentSessionKey && served.serial === request.serial) return;
            showPositionTarget(linkTarget(request, scrollNode), scrollNode, currentSessionKey, null, null);
        };
        showRequested();
        return subscribeMessageFocus(showRequested);
    }, [currentSessionKey, scrollNode, showPositionTarget]);

    React.useEffect(() => {
        if (pinned || !scrollNode || !currentSessionKey) return;
        const showRequested = () => {
            if (scrollRef.current !== scrollNode || handledEntryKeyRef.current !== currentSessionKey) return;
            const pageId = pendingWaitingPageID();
            if (!takeWaitingPageReveal(currentSessionIdRef.current)) return;
            restoreRef.current?.cancel();
            jumpToEnd('instant', true);
            revealedPagesRef.current.clear();
            const block = findWaitingPage(scrollNode, pageId);
            if (pageId === null || !block) {
                dispatchPageWaiting(block);
                return;
            }
            revealedPagesRef.current.add(pageId);
            pageRevealRef.current = { pageId, block, generation: userGenerationRef.current, until: performance.now() + PAGE_REVEAL_SETTLE_MS };
            revealWaitingPageRef.current();
        };
        showRequested();
        return subscribeRequestReveal(showRequested);
    }, [currentSessionKey, jumpToEnd, pinned, scrollNode]);

    React.useEffect(() => {
        if (!scrollNode) return;
        const glide = createKeyboardFollowGlide({
            scrollNode,
            canFollow: () => !userOwnsScrollRef.current && isAtEndRef.current && modeRef.current === 'following-end',
        });
        followGlideRef.current = glide;
        return () => {
            glide.dispose();
            if (followGlideRef.current === glide) followGlideRef.current = null;
        };
    }, [scrollNode]);

    const followLandedRef = React.useRef<() => void>(() => {});
    const followYieldsRef = React.useRef(0);
    React.useEffect(() => {
        if (!scrollNode) return;
        const glide = createFollowGlide({
            node: scrollNode,
            native: drawsScrollInWholePixels(),
            shouldContinue: () => scrollRef.current === scrollNode && !followGlideHeld(),
            onSettle: () => followLandedRef.current(),
            onYield: () => {
                if (followYieldsRef.current >= 2) return;
                followYieldsRef.current += 1;
                followLandedRef.current();
            },
        });
        liveGlideRef.current = glide;
        return () => {
            glide.dispose();
            if (liveGlideRef.current === glide) liveGlideRef.current = null;
        };
    }, [scrollNode]);

    React.useEffect(() => {
        if (!scrollNode || !globalThis.MutationObserver) return;
        const content = scrollNode.firstElementChild;
        if (!content) return;
        const pin = () => {
            if (userOwnsScrollRef.current || !isAtEndRef.current || modeRef.current !== 'following-end') return;
            if (followGlideHeld()) return;
            if (widthResizingRef.current || isLayoutAnimating()) {
                const state = listRef.current?.getState();
                const measured = state
                    ? resolveRealContentEndOffset({
                        state,
                        headerSize: listHeaderSizeRef.current,
                        footerSize: listFooterSizeRef.current,
                    })
                    : null;
                const offset = measured === null ? null : measured + (pinnedThroughAnimationRef.current ? animationEndCorrectionRef.current : 0);
                if (offset !== null && Math.abs(offset - scrollNode.scrollTop) > 1) {
                    scrollNode.scrollTop = offset;
                }
                return;
            }
            if (isLive()) {
                if (streamingAutoFollowEnabledRef.current) followEnd();
                return;
            }
            pinEndAtRest(scrollNode);
        };
        const grew = () => {
            followYieldsRef.current = 0;
            pin();
        };
        const mutations = new MutationObserver(grew);
        mutations.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
        const resizes = globalThis.ResizeObserver ? new ResizeObserver(grew) : null;
        resizes?.observe(content);
        resizes?.observe(scrollNode);
        followLandedRef.current = () => {
            if (userOwnsScrollRef.current || !isAtEndRef.current || modeRef.current !== 'following-end') return;
            const remaining = scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop;
            if (remaining <= 1) return;
            if (remaining <= FOLLOW_LANDING_SNAP_MAX_PX) {
                scrollNode.scrollTop += remaining;
                return;
            }
            pin();
        };
        return () => {
            mutations.disconnect();
            resizes?.disconnect();
            followLandedRef.current = () => {};
        };
    }, [followEnd, pinEndAtRest, scrollNode]);

    React.useEffect(() => {
        if (!scrollNode) return;
        let startGeneration = 0;
        const settle = () => {
            if (!pinnedThroughAnimationRef.current) return;
            pinnedThroughAnimationRef.current = false;
            if (userGenerationRef.current !== startGeneration || userOwnsScrollRef.current) return;
            isAtEndRef.current = true;
            modeRef.current = 'following-end';
            const state = listRef.current?.getState();
            const offset = state
                ? resolveRealContentEndOffset({
                    state,
                    headerSize: listHeaderSizeRef.current,
                    footerSize: listFooterSizeRef.current,
                })
                : null;
            const end = offset === null ? scrollNode.scrollHeight - scrollNode.clientHeight : offset + animationEndCorrectionRef.current;
            if (Math.abs(end - scrollNode.scrollTop) > 1) scrollNode.scrollTop = end;
        };
        const release = onLayoutAnimationStart(() => {
            if (userOwnsScrollRef.current || !isAtEndRef.current || modeRef.current !== 'following-end') return;
            const state = listRef.current?.getState();
            const measured = state
                ? resolveRealContentEndOffset({
                    state,
                    headerSize: listHeaderSizeRef.current,
                    footerSize: listFooterSizeRef.current,
                })
                : null;
            const correction = measured === null ? 0 : scrollNode.scrollTop - measured;
            animationEndCorrectionRef.current = Math.abs(correction) <= ANIMATION_END_CORRECTION_MAX_PX ? correction : 0;
            pinnedThroughAnimationRef.current = true;
            startGeneration = userGenerationRef.current;
            runWhenLayoutSettled(settle);
        });
        return () => {
            release();
            cancelWhenLayoutSettled(settle);
            pinnedThroughAnimationRef.current = false;
        };
    }, [scrollNode]);

    React.useEffect(() => {
        if (!scrollNode) return;
        const settle = () => scrollNode.removeAttribute('data-columns-moving');
        const release = onWidthDragStart(() => {
            scrollNode.setAttribute('data-columns-moving', '');
            runWhenLayoutSettled(settle);
        });
        return () => {
            release();
            cancelWhenLayoutSettled(settle);
            settle();
        };
    }, [scrollNode]);

    React.useEffect(() => {
        setIsFollowingProgrammatically(!showScrollButton && !userOwnsScroll);
    }, [showScrollButton, userOwnsScroll]);

    React.useEffect(() => () => {
        cancelShowButtonTimer();
        clearGoToBottomReasserts();
        restoreRef.current?.cancel();
    }, [cancelShowButtonTimer, clearGoToBottomReasserts]);

    React.useEffect(() => {
        if (!onActiveTurnChange) return;
        const container = scrollNode;
        if (!container) return;

        let lastActiveTurnId: string | null = null;
        const spy = createScrollSpy({
            onActive: (turnId) => {
                if (turnId === lastActiveTurnId) return;
                lastActiveTurnId = turnId;
                onActiveTurnChange(turnId);
            },
        });
        spy.setContainer(container);

        const TURN_ROW_SELECTOR = '[data-turn-id], [data-turn-row]';
        const turnIdOfRow = (node: HTMLElement) => node.dataset.turnId ?? node.dataset.turnRow;
        const registerTurnNode = (node: HTMLElement) => {
            const turnId = turnIdOfRow(node);
            if (!turnId) return false;
            spy.register(node, turnId);
            return true;
        };
        const unregisterTurnNode = (node: HTMLElement) => {
            spy.unregister(node);
            return true;
        };
        const collectTurnNodes = (node: Node): HTMLElement[] => {
            if (!(node instanceof HTMLElement)) return [];
            const collected: HTMLElement[] = [];
            if (node.matches(TURN_ROW_SELECTOR)) collected.push(node);
            node.querySelectorAll<HTMLElement>(TURN_ROW_SELECTOR).forEach((el) => collected.push(el));
            return collected;
        };

        container.querySelectorAll<HTMLElement>(TURN_ROW_SELECTOR).forEach(registerTurnNode);
        spy.markDirty();

        const mutationObserver = new MutationObserver((records) => {
            let changed = false;
            records.forEach((record) => {
                record.removedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (unregisterTurnNode(turnNode)) changed = true;
                    });
                });
                record.addedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (registerTurnNode(turnNode)) changed = true;
                    });
                });
            });
            if (changed) spy.markDirty();
        });
        mutationObserver.observe(container, { subtree: true, childList: true });

        const onScroll = () => spy.onScroll();
        container.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', onScroll);
            mutationObserver.disconnect();
            spy.destroy();
        };
    }, [onActiveTurnChange, scrollNode]);

    return {
        scrollRef,
        scrollNode,
        isPinned,
        registerList,
        captureOutgoingPosition,
        onIsAtEndChange,
        onListMetricsChange,
        onManualNavigation,
        takeViewport,
        onTimelineDataChange,
        showScrollButton,
        userOwnsScroll,
        nearContentStart,
        isFollowingProgrammatically,
        goToBottom,
        scrollToBottomOnSend,
        restoreSnapshot,
    };
};
