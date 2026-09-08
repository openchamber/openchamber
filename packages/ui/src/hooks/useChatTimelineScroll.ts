import React from 'react';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import { useViewportStore } from '@/sync/viewport-store';
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
    isFollowReleaseKey,
    isMiddleButtonPan,
    nestedScrollableConsumesWheelUp,
} from '@/components/chat/lib/scroll/timelineScrollIntent';

// ──────────────────────────────────────────────────────────────────────────
// Chat timeline scroll ownership.
//
// The virtualized list owns the scroll position; this hook only decides which
// of two mutually exclusive modes is active and, when a mode calls for it,
// issues ONE deterministic scroll command:
//
//   • `following-end`      — pinned to the live edge. The list keeps us there
//     through `maintainScrollAtEnd`; we only re-assert after a data change.
//   • `free-scrolling`     — the user took over. Nothing moves until they opt
//     back in by returning to the end.
//
// Opting out of automatic movement is driven by REAL gestures (wheel /
// touchmove / pointerdown), not by inferring intent from scroll positions. Each
// gesture bumps a generation counter; any in-flight automatic movement compares
// its captured generation against the current one and aborts if they differ.
// That comparison replaces the timer windows the previous implementation needed
// to tell its own writes apart from the user's, which is why there are no
// guard/settle/entry-stick timers here.
// ──────────────────────────────────────────────────────────────────────────

// The subset of the list ref this hook drives. Declared structurally so the
// hook stays testable without a renderer and does not hard-depend on the list
// implementation.
export interface TimelineListHandle {
    getState: () => TimelineListMeasurementState & {
        readonly scroll: number;
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

interface UseChatTimelineScrollOptions {
    currentSessionId: string | null;
    currentSessionKey: string | null;
    sessionMessageCount: number;
    composerOverlayHeight: number;
    // True while the session is producing output. Follow corrections glide
    // only then. Outside a live stream — entering a session, a tab becoming
    // active, rows re-measuring after a switch — the viewport must land on
    // the end instantly: an animated catch-up scrolls visibly through the
    // conversation and gets cut short by the next measurement.
    sessionIsWorking: boolean;
    // Reveal gate of the session being opened. Held until the viewport is
    // pinned to the end, so the session is never shown scrolled to the top.
    revealGate?: TimelineRevealGate | null;
    onActiveTurnChange?: (turnId: string | null) => void;
}



export interface UseChatTimelineScrollResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    // The live scroll element, as state, so effects that must re-bind when the
    // list remounts (session switch) can depend on it.
    scrollNode: HTMLDivElement | null;
    isPinned: boolean;
    registerList: (list: TimelineListHandle | null) => void;
    onIsAtEndChange: (isAtEnd: boolean) => void;
    onListMetricsChange: (metrics: { readonly footerSize: number }) => void;
    onManualNavigation: () => void;
    onTimelineDataChange: () => void;
    showScrollButton: boolean;
    /** A real gesture took the scroll; flips back on any explicit opt-in. */
    userOwnsScroll: boolean;
    isFollowingProgrammatically: boolean;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    scrollToBottomOnSend: () => void;
    saveSnapshotNow: () => void;
    restoreSnapshot: () => Promise<boolean>;
}

// Showing the pill is debounced so it does not flash while a thread switch
// settles (the list reports isAtEnd=false until its initial end-scroll lands).
// Hiding is always immediate.
const SHOW_SCROLL_BUTTON_DELAY_MS = 150;
const SAVE_DEBOUNCE_MS = 150;

export const useChatTimelineScroll = ({
    currentSessionId,
    currentSessionKey,
    sessionMessageCount,
    composerOverlayHeight,
    sessionIsWorking,
    revealGate = null,
    onActiveTurnChange,
}: UseChatTimelineScrollOptions): UseChatTimelineScrollResult => {
    const sessionIsWorkingRef = React.useRef(sessionIsWorking);
    sessionIsWorkingRef.current = sessionIsWorking;
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const listRef = React.useRef<TimelineListHandle | null>(null);

    const [scrollNode, setScrollNode] = React.useState<HTMLDivElement | null>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    // "Pinned" is the live edge, which history pagination uses to decide whether
    // it may load older pages without disturbing the read position.
    const [isPinned, setIsPinned] = React.useState(true);
    const [isFollowingProgrammatically, setIsFollowingProgrammatically] = React.useState(false);
    // True after a real gesture until an explicit opt back in; drives the
    // overlay scrollbar suppression instead of the anchor's mere existence.
    const [userOwnsScroll, setUserOwnsScroll] = React.useState(false);
    const userOwnsScrollRef = React.useRef(userOwnsScroll);
    userOwnsScrollRef.current = userOwnsScroll;

    const modeRef = React.useRef<TimelineScrollMode>('following-end');
    const isAtEndRef = React.useRef(true);
    // Incremented by every real user gesture. Automatic movement is only valid
    // while `liveFollowGenerationRef` still equals it.
    const userGenerationRef = React.useRef(0);
    const liveFollowGenerationRef = React.useRef<number | null>(0);
    const showButtonTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const composerOverlayHeightRef = React.useRef(composerOverlayHeight);
    composerOverlayHeightRef.current = composerOverlayHeight;
    // Size of the list footer, reported by the list as it is measured; the
    // real content end sits below the last row by this much.
    const listFooterSizeRef = React.useRef(0);
    const onListMetricsChange = React.useCallback((metrics: { readonly footerSize: number }) => {
        listFooterSizeRef.current = Number.isFinite(metrics.footerSize) ? metrics.footerSize : 0;
    }, []);
    const sessionMessageCountRef = React.useRef(sessionMessageCount);
    sessionMessageCountRef.current = sessionMessageCount;
    const currentSessionIdRef = React.useRef(currentSessionId);
    currentSessionIdRef.current = currentSessionId;
    const currentSessionKeyRef = React.useRef(currentSessionKey);
    currentSessionKeyRef.current = currentSessionKey;

    const updateViewportAnchor = useViewportStore((state) => state.updateViewportAnchor);

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

    // A real gesture: stop every automatic movement until the user opts back
    // in.
    const onManualNavigation = React.useCallback(() => {
        userGenerationRef.current += 1;
        modeRef.current = 'free-scrolling';
        liveFollowGenerationRef.current = null;
        setUserOwnsScroll(true);
        // The end may already have been left by our own movement, in which
        // case no further at-end transition will fire — and while an animated
        // follow glide trails the live edge, isAtEndRef is deliberately not
        // updated, so measure the real distance instead of trusting it. This
        // is an explicit gesture — show the pill immediately, no debounce.
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

    // ── snapshot persistence ────────────────────────────────────────────────
    const pendingSaveRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const flushSave = React.useCallback(() => {
        if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        const pending = pendingSaveRef.current;
        if (!pending) return;
        const container = scrollRef.current;
        if (!container) {
            pendingSaveRef.current = null;
            return;
        }
        updateViewportAnchor(pending.sessionId, pending.anchor, {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        });
        pendingSaveRef.current = null;
    }, [updateViewportAnchor]);

    const queueSave = React.useCallback(() => {
        const sessionId = currentSessionIdRef.current;
        if (!sessionId) return;
        const container = scrollRef.current;
        if (!container) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const anchorRatio = scrollHeight > 0
            ? (scrollTop + clientHeight / 2) / scrollHeight
            : 0;
        const anchor = Math.floor(anchorRatio * sessionMessageCountRef.current);

        pendingSaveRef.current = { sessionId, anchor };
        if (saveTimerRef.current !== null) return;
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            flushSave();
        }, SAVE_DEBOUNCE_MS);
    }, [flushSave]);

    const saveSnapshotNow = React.useCallback(() => {
        flushSave();
    }, [flushSave]);

    // ── scroll commands ─────────────────────────────────────────────────────
    const goToBottomReassertTimersRef = React.useRef<Array<ReturnType<typeof setTimeout>>>([]);
    const clearGoToBottomReasserts = React.useCallback(() => {
        for (const timer of goToBottomReassertTimersRef.current) clearTimeout(timer);
        goToBottomReassertTimersRef.current = [];
    }, []);

    const goToBottom = React.useCallback((mode: 'instant' | 'smooth' = 'instant') => {
        isAtEndRef.current = true;
        setIsPinned(true);
        setUserOwnsScroll(false);
        modeRef.current = 'following-end';
        // Returning to the end is an explicit opt back IN to live follow.
        liveFollowGenerationRef.current = userGenerationRef.current;
        hideScrollButton();
        void listRef.current?.scrollToEnd({ animated: mode === 'smooth' });
        // While a stream is growing the content, a single jump lands on the
        // end as of that moment and the list's own follow may not have
        // re-armed yet — re-assert a few times until the edge holds, then the
        // library follows onward. A new user gesture invalidates the window.
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
    }, [clearGoToBottomReasserts, hideScrollButton]);

    // User preference: with auto-follow off, streaming growth never moves the
    // viewport. Sending from the live edge still lands on the end; sending
    // from mid-history leaves the viewport untouched.
    const streamingAutoFollowEnabled = useUIStore((state) => state.streamingAutoFollowEnabled);
    const streamingAutoFollowEnabledRef = React.useRef(streamingAutoFollowEnabled);
    streamingAutoFollowEnabledRef.current = streamingAutoFollowEnabled;

    // Sending is an explicit return to the live edge: the sent row and the
    // reply that follows it stay in view through ordinary end-follow.
    const scrollToBottomOnSend = React.useCallback(() => {
        // With auto-follow off, a reader who scrolled away from the end stays
        // exactly where they are; the scroll-to-bottom pill (already showing)
        // leads to the sent message.
        if (!streamingAutoFollowEnabledRef.current && !isAtEndRef.current) return;
        goToBottom('instant');
    }, [goToBottom]);

    const restoreSnapshot = React.useCallback(async (): Promise<boolean> => {
        const sessionKey = currentSessionKeyRef.current;
        if (!sessionKey) return false;

        // Entering a session always returns to the live edge. Late async growth
        // is handled by the list staying at the end, not by a timed hold.
        isAtEndRef.current = true;
        setUserOwnsScroll(false);
        modeRef.current = 'following-end';
        liveFollowGenerationRef.current = userGenerationRef.current;
        hideScrollButton();
        void listRef.current?.scrollToEnd({ animated: false });
        return false;
    }, [hideScrollButton]);

    // ── list callbacks ──────────────────────────────────────────────────────
    const registerList = React.useCallback((list: TimelineListHandle | null) => {
        listRef.current = list;
        const node = (list?.getScrollableNode() as HTMLDivElement | null) ?? null;
        scrollRef.current = node;
        setScrollNode(node);
    }, []);

    const onIsAtEndChange = React.useCallback((isAtEnd: boolean) => {
        // While an automatic movement owns the viewport, leaving the end is our
        // own doing (the glide trails its target between corrections) — not a
        // reason to offer the pill. Only a
        // real gesture (free-scrolling) shows it.
        if (!isAtEnd && isLiveFollowActive()) {
            hideScrollButton();
            return;
        }
        if (isAtEndRef.current === isAtEnd) return;
        isAtEndRef.current = isAtEnd;
        setIsPinned(isAtEnd);
        if (isAtEnd) {
            modeRef.current = 'following-end';
            liveFollowGenerationRef.current = userGenerationRef.current;
            setUserOwnsScroll(false);
            hideScrollButton();
        } else {
            modeRef.current = 'free-scrolling';
            liveFollowGenerationRef.current = null;
            scheduleShowScrollButton();
        }
        queueSave();
    }, [hideScrollButton, isLiveFollowActive, queueSave, scheduleShowScrollButton]);

    // Whether the real rows are tall enough to scroll at all.
    const realContentOverflowsViewport = React.useCallback((list: TimelineListHandle): boolean => {
        const state = list.getState();
        if (state.data.length === 0) return false;

        const lastIndex = state.data.length - 1;
        const lastTop = state.positionAtIndex(lastIndex);
        const lastHeight = state.sizeAtIndex(lastIndex);
        if (
            typeof lastTop !== 'number'
            || typeof lastHeight !== 'number'
            || !Number.isFinite(lastTop)
            || !Number.isFinite(lastHeight)
        ) {
            return false;
        }

        const realContentBottom = lastTop + Math.max(1, lastHeight);
        const visibleScrollLength = Math.max(0, state.scrollLength - composerOverlayHeightRef.current);
        return realContentBottom > visibleScrollLength;
    }, []);

    // While the list width is resizing every row re-wraps, and the list's
    // total content length lags a frame behind the rows it contains: it
    // still carries pre-wrap row sizes, so any end computed from it (the
    // list's own maintainScrollAtEnd, the scroll node's scrollHeight) lands
    // on a blank tail or short of the real end and the viewport bounces.
    // A pinned reader — streaming or idle — stays on the end throughout: the
    // pinned-end observer below re-asserts the MEASURED end of the last real
    // row on every layout write, and once the resize settles the end is
    // asserted one last time against the same measurement. An unpinned
    // reader is held in place by the list's size compensation instead and
    // is never scrolled.
    const widthResizingRef = React.useRef(false);
    React.useEffect(() => {
        if (!scrollNode || typeof ResizeObserver === 'undefined') return;
        let lastWidth: number | null = null;
        let quietTimer: ReturnType<typeof setTimeout> | null = null;
        const observer = new ResizeObserver((observerEntries) => {
            const width = observerEntries[observerEntries.length - 1]?.contentRect.width;
            if (typeof width !== 'number') return;
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
                        composerOverlayHeight: composerOverlayHeightRef.current,
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
        };
    }, [scrollNode]);

    // Keep the live edge in view after content growth. Within a viewport of
    // the end the remaining distance is glided so a revealed block and the
    // scroll read as one motion; further behind, the viewport first jumps to
    // one screen above the end and glides only that last screen, so the
    // reader is never left staring at a gap several screens tall. Writes go
    // to the scroll node directly: routing each chunk through the list's
    // scrollToEnd bookkeeping roughly doubled frame production when measured.
    // A user gesture interrupts the native smooth scroll on its own, and the
    // gesture handler drops live follow so no later correction re-engages.
    const followEnd = React.useCallback(() => {
        const node = scrollRef.current;
        if (!node) return;
        const end = node.scrollHeight - node.clientHeight;
        const distance = end - node.scrollTop;
        if (distance <= 1) return;
        if (!sessionIsWorkingRef.current) {
            node.scrollTop = end;
            return;
        }
        if (distance > node.clientHeight) {
            node.scrollTop = end - node.clientHeight;
        }
        node.scrollTo({ top: end, behavior: 'smooth' });
    }, []);

    const onTimelineDataChange = React.useCallback(() => {
        if (widthResizingRef.current) return;

        // Stranded-viewport rescue, independent of any follow mode or
        // preference: when off-screen size estimates settle smaller than
        // estimated, the measured content can end ABOVE the viewport while
        // the scroll offset stays at the stale end — the reader faces a blank
        // phantom tail with every row out of reach above. That state is never
        // intentional, so it is corrected even when auto-follow is off. Only
        // a fully blank viewport qualifies; partial visibility is left alone.
        if (!userOwnsScrollRef.current) {
            const list = listRef.current;
            if (list) {
                const state = list.getState();
                const lastIndex = state.data.length - 1;
                const lastBottom = lastIndex >= 0 ? getRowBottom(state, lastIndex) : null;
                if (lastBottom !== null && state.scroll > lastBottom) {
                    const offset = resolveRealContentEndOffset({
                        state,
                        composerOverlayHeight: composerOverlayHeightRef.current,
                        footerSize: listFooterSizeRef.current,
                    });
                    if (offset !== null) {
                        void list.scrollToOffset({ offset, animated: false });
                        return;
                    }
                }
            }
        }

        if (!streamingAutoFollowEnabledRef.current) {
            // With auto-follow off nothing moves the viewport, so a growing
            // reply slides below the visible area without a single scroll
            // event — and the at-end transition that offers the pill never
            // fires. Content growth is the signal here: once the real last
            // row extends past what the composer leaves visible, the reader
            // is factually behind and the pill must say so.
            const list = listRef.current;
            if (list && isAtEndRef.current) {
                const state = list.getState();
                const lastIndex = state.data.length - 1;
                const lastBottom = lastIndex >= 0 ? getRowBottom(state, lastIndex) : null;
                if (lastBottom !== null) {
                    const visibleBottom = state.scroll + state.scrollLength - composerOverlayHeightRef.current;
                    if (lastBottom - visibleBottom > TIMELINE_FOLLOW_REARM_THRESHOLD_PX) {
                        isAtEndRef.current = false;
                        setIsPinned(false);
                        scheduleShowScrollButton();
                    }
                }
            }
            return;
        }
        if (!isLiveFollowActive()) return;

        // Following the end is owned here, not left to the list's
        // maintainScrollAtEnd. The list's animated maintain is single-flight:
        // growth that lands while a glide is still in flight is dropped until
        // the next trigger, and its re-pin threshold is a tenth of the
        // viewport. In a narrow viewport (the VS Code sidebar) one revealed
        // block is several viewports tall, so every block left the reader a
        // second behind and multiple screens above the live edge — measured
        // at 45% of the stream time spent 500-1600px behind at 420x640.
        if (modeRef.current !== 'following-end') return;
        followEnd();
    }, [followEnd, isLiveFollowActive, scheduleShowScrollButton]);

    // The streaming tail grows inside one row without changing the entries
    // array, so data-change callbacks are silent for the entire stream. The
    // list's total content size is the authoritative growth signal; every
    // change re-runs the same guarded correction.
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

    // ── gesture opt-out ─────────────────────────────────────────────────────
    const onManualNavigationRef = React.useRef(onManualNavigation);
    onManualNavigationRef.current = onManualNavigation;

    React.useEffect(() => {
        if (!scrollNode) return;

        // A gesture is meaningful when the viewport can move up AT ALL:
        // either the real rows overflow the viewport, or there is scrolled
        // history above.
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
            // Scrolling toward the end is not opting out of follow, and an
            // upward wheel that a nested scroller still consumes never
            // reaches the timeline.
            if (event.deltaY < 0 && !nestedScrollableConsumesWheelUp(scrollNode, event.target) && canScrollUp()) {
                gesture();
            }
        };
        // Touch mirrors wheel by finger direction, not by having already left
        // the end: while a stream keeps re-pinning the viewport, waiting for
        // an at-end transition means the drag never registers — the user
        // cannot scroll, the pill never appears, and live-follow stays armed
        // under a viewport they are fighting for.
        let touchLastY: number | null = null;
        const handleTouchStart = (event: TouchEvent) => {
            touchLastY = event.touches[0]?.clientY ?? null;
        };
        const handleTouchMove = (event: TouchEvent) => {
            const y = event.touches[0]?.clientY ?? null;
            const lastY = touchLastY;
            touchLastY = y;
            if (y === null) return;
            // A downward finger drags the content up — the touch wheel-up.
            const draggedUp = lastY !== null && y > lastY;
            if ((draggedUp || !isAtEndRef.current) && canScrollUp()) gesture();
        };
        const handleTouchEnd = () => {
            touchLastY = null;
        };
        const handlePointerDown = (event: PointerEvent) => {
            // A middle-button pan scrolls without wheel events (and is the
            // only scroll gesture for wheel-less mice), so the press is the
            // opt-out. Otherwise the scrollbar track is the scroll node
            // itself; a tap on a row only breaks follow when the viewport
            // already left the end.
            if (isMiddleButtonPan(scrollNode, event)) {
                if (canScrollUp()) gesture();
                return;
            }
            if ((event.target === scrollNode || !isAtEndRef.current) && canScrollUp()) gesture();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (isFollowReleaseKey(event) && canScrollUp()) gesture();
        };
        const handleScroll = () => {
            queueSave();
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
        };
    }, [queueSave, realContentOverflowsViewport, scrollNode]);

    // ── entry pin ───────────────────────────────────────────────────────────
    // An opened session is shown once, already at its end: the reveal gate is
    // held until the viewport sits on the end, and the pin is one instant
    // write. The list lays its rows out before the first frame, so this
    // resolves within a frame; the gate's own cap bounds the wait.
    React.useLayoutEffect(() => {
        if (!currentSessionKey || !scrollNode) return;
        const releaseReveal = revealGate?.hold() ?? null;
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
    }, [currentSessionKey, revealGate, scrollNode]);

    // ── pinned end ──────────────────────────────────────────────────────────
    // "At the end" is an invariant, not a one-time scroll: while the reader
    // sits on the end of a session that is not producing output, any growth
    // of the content (a footer that decides to render, a row re-measured)
    // keeps the end in view with one instant write. Output growth belongs to
    // followEnd, which glides. A width resize is the one case handled for a
    // streaming reader as well — see the resize observer above.
    React.useEffect(() => {
        if (!scrollNode || typeof MutationObserver === 'undefined') return;
        const content = scrollNode.firstElementChild;
        if (!content) return;
        const pin = () => {
            if (userOwnsScrollRef.current || !isAtEndRef.current || modeRef.current !== 'following-end') return;
            if (widthResizingRef.current) {
                // Re-wrapping rows: the scroll node's scrollHeight carries the
                // list's stale total, so the end is the measured bottom of the
                // last real row. Held for a streaming reader too — output
                // growth is not what moves the viewport during a resize.
                const state = listRef.current?.getState();
                const offset = state
                    ? resolveRealContentEndOffset({
                        state,
                        composerOverlayHeight: composerOverlayHeightRef.current,
                        footerSize: listFooterSizeRef.current,
                    })
                    : null;
                if (offset !== null && Math.abs(offset - scrollNode.scrollTop) > 1) {
                    scrollNode.scrollTop = offset;
                }
                return;
            }
            if (sessionIsWorkingRef.current) return;
            const end = scrollNode.scrollHeight - scrollNode.clientHeight;
            if (end - scrollNode.scrollTop > 1) scrollNode.scrollTop = end;
        };
        // A MutationObserver runs as a microtask right after the list writes
        // its layout (row positions, container height), before the frame is
        // painted, so the pin lands in the same frame as the growth. A
        // ResizeObserver would only see the container a rendering step later
        // and let one frame paint with the end out of view.
        const mutations = new MutationObserver(pin);
        mutations.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
        const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(pin);
        resizes?.observe(content);
        return () => {
            mutations.disconnect();
            resizes?.disconnect();
        };
    }, [scrollNode]);

    // ── session lifecycle ───────────────────────────────────────────────────
    const lastSessionKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!currentSessionId || !currentSessionKey || currentSessionKey === lastSessionKeyRef.current) {
            return;
        }
        lastSessionKeyRef.current = currentSessionKey;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        // Persist the outgoing session's position before the new one takes over.
        flushSave();
        isAtEndRef.current = true;
        setUserOwnsScroll(false);
        modeRef.current = 'following-end';
        liveFollowGenerationRef.current = userGenerationRef.current;
        hideScrollButton();
    }, [currentSessionId, currentSessionKey, flushSave, hideScrollButton]);

    // Suppress the overlay scrollbar thumb while automatic movement owns the
    // scroll position, so it does not jump on each correction.
    React.useEffect(() => {
        setIsFollowingProgrammatically(!showScrollButton && !userOwnsScroll);
    }, [showScrollButton, userOwnsScroll]);

    React.useEffect(() => () => {
        cancelShowButtonTimer();
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    }, [cancelShowButtonTimer]);

    // ── active-turn spy ─────────────────────────────────────────────────────
    // Reads turn positions straight from the DOM, so it is unaffected by which
    // list implementation owns the container. Rows mounting and unmounting
    // during virtualized scrolling are tracked through the mutation observer.
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

        const elementByTurnId = new Map<string, HTMLElement>();
        const registerTurnNode = (node: HTMLElement) => {
            const turnId = node.dataset.turnId;
            if (!turnId) return false;
            elementByTurnId.set(turnId, node);
            spy.register(node, turnId);
            return true;
        };
        const unregisterTurnNode = (node: HTMLElement) => {
            const turnId = node.dataset.turnId;
            if (!turnId) return false;
            if (elementByTurnId.get(turnId) !== node) return false;
            elementByTurnId.delete(turnId);
            spy.unregister(turnId);
            return true;
        };
        const collectTurnNodes = (node: Node): HTMLElement[] => {
            if (!(node instanceof HTMLElement)) return [];
            const collected: HTMLElement[] = [];
            if (node.matches('[data-turn-id]')) collected.push(node);
            node.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((el) => collected.push(el));
            return collected;
        };

        container.querySelectorAll<HTMLElement>('[data-turn-id]').forEach(registerTurnNode);
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
        onIsAtEndChange,
        onListMetricsChange,
        onManualNavigation,
        onTimelineDataChange,
        showScrollButton,
        userOwnsScroll,
        isFollowingProgrammatically,
        goToBottom,
        scrollToBottomOnSend,
        saveSnapshotNow,
        restoreSnapshot,
    };
};
