import React from 'react';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import { useViewportStore } from '@/sync/viewport-store';

type AutoFollowState = 'following' | 'released';

export type ContentChangeReason = 'text' | 'structural' | 'permission' | 'animation';

export interface AnimationHandlers {
    onChunk: () => void;
    onComplete: () => void;
    onStreamingCandidate?: () => void;
    onAnimationStart?: () => void;
    onReservationCancelled?: () => void;
    onReasoningBlock?: () => void;
    onAnimatedHeightChange?: (height: number) => void;
}

interface UseChatAutoFollowOptions {
    currentSessionId: string | null;
    sessionMessageCount: number;
    sessionIsWorking: boolean;
    isMobile: boolean;
    onActiveTurnChange?: (turnId: string | null) => void;
}

export interface UseChatAutoFollowResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    state: AutoFollowState;
    isPinned: boolean;
    isOverflowing: boolean;
    isFollowingProgrammatically: boolean;
    showScrollButton: boolean;
    notifyContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    scrollToBottomOnSend: () => void;
    releaseAutoFollow: () => void;
    saveSnapshotNow: () => void;
    restoreSnapshot: () => Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────────
// Chat auto-follow. The model is deliberately simple, which is what makes it
// flicker-free:
//
//   • Auto-follow is on unless the user scrolled up (`released`), AND passive
//     following only acts while the session is active (working, plus a short
//     settle window). When idle, content-size changes are layout churn
//     (virtualizer re-measurement, async tool/code rendering) rather than live
//     growth, so the hook leaves scroll alone — re-pinning then would fight the
//     virtualizer and twitch the viewport.
//   • Following the bottom is INSTANT — `scrollTop = scrollHeight` inside the
//     content ResizeObserver, which fires after layout and before paint. There
//     is NO easing loop and NO settle burst, so there are never two writers
//     racing for `scrollTop` (the root cause of the old jiggle/double-scroll).
//   • A short-lived "auto" marker (position + 1500ms) lets the scroll handler
//     distinguish our own programmatic writes from genuine user scrolling, so
//     a scroll event that lands at our just-written bottom never trips a false
//     release.
//
// The public interface below is unchanged from the old implementation so every
// consumer (ChatContainer, message parts, the timeline controller) keeps
// working without edits.
// ──────────────────────────────────────────────────────────────────────────

const BOTTOM_SPACER_DESKTOP_VH = 0.10;
const BOTTOM_SPACER_MOBILE_PX = 40;
const SAVE_DEBOUNCE_MS = 150;
const TOUCH_FINGER_DOWN_THRESHOLD = 2;
// How long an "auto" (programmatic) scroll position stays trusted. Browsers can
// dispatch the `scroll` event for our write asynchronously, after newer content
// has already changed the geometry; the window keeps us from reading that lag as
// a user scroll.
const AUTO_MARK_TTL_MS = 1500;
const AUTO_MATCH_TOLERANCE_PX = 2;
// While a tracked height animation runs (e.g. a Thinking block auto-collapsing
// mid-stream), the timeline shrinks/grows over a couple hundred ms and the
// virtualizer re-measures, producing transient geometry. Browsers dispatch the
// resulting `scroll` events asynchronously, so a stale event can land after we
// have already re-pinned — its position matching neither the bottom zone nor the
// freshly-moved auto marker — and be misread as a user scroll-away. During this
// guard window we treat any `following`-state scroll event as our own and never
// release via the heuristic. GENUINE user gestures still release instantly
// through releaseFromUserIntent, so this is not glue. Sized to the reasoning
// animation (200ms) plus headroom for trailing async scroll events.
const ANIMATION_GUARD_MS = 350;
// After streaming stops, keep following the bottom for a short window so the
// final content can settle into place.
const SETTLE_MS = 300;
const REPIN_GRACE_AFTER_RELEASE_MS = 1200;
// Entry-stick window. On the FIRST open of a session, late async data (most
// visibly a task/subagent tool whose nested rows are fetched from the child
// session after entry — see useEnsureSessionMessages in ToolPart.tsx) grows the
// timeline a beat or two AFTER we have already pinned to the bottom, leaving the
// viewport stranded mid-history. The steady-state idle gate deliberately ignores
// that growth (it can't tell entry from a user reading idle history). So instead
// of weakening the gate, we open a short, gesture-cancellable window on entry
// during which we FORCE the bottom on every growth. It ends QUIESCENCE_MS after
// growth stops (capped by MAX_MS), or instantly on any real user scroll gesture.
const ENTRY_STICK_QUIESCENCE_MS = 600;
const ENTRY_STICK_MAX_MS = 8000;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// The bottom of the chat has an empty spacer (10vh on desktop, 40px on mobile)
// — its height is exactly how far above scrollHeight the user can be while still
// looking at "empty" space. We use that same value as the threshold for both
// re-pinning auto-follow and showing the scroll-to-bottom button.
const computeBottomZoneThreshold = (isMobile: boolean, container?: HTMLElement | null): number => {
    if (isMobile) return BOTTOM_SPACER_MOBILE_PX;
    const height = container?.clientHeight ?? 0;
    if (height <= 0) return 96;
    return Math.max(48, height * BOTTOM_SPACER_DESKTOP_VH);
};

const distanceFromBottom = (el: HTMLElement): number => {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
};

const canScroll = (el: HTMLElement): boolean => {
    return el.scrollHeight - el.clientHeight > 1;
};

const isNearBottom = (el: HTMLElement, isMobile: boolean): boolean => {
    return distanceFromBottom(el) <= computeBottomZoneThreshold(isMobile, el);
};

export const isAutoFollowReleaseKey = (event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
        return false;
    }
    if (event.key === ' ' && event.shiftKey) {
        return true;
    }
    switch (event.key) {
        case 'ArrowUp':
        case 'PageUp':
        case 'Home':
        case 'Pause':
        case 'Break':
            return true;
        default:
            return false;
    }
};

const nestedScrollableTarget = (root: HTMLElement, target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const nested = target.closest('[data-scrollable]');
    if (!nested || nested === root || !(nested instanceof HTMLElement)) return null;
    return nested;
};

export const isMiddleButtonAutoScrollIntent = (root: HTMLElement, event: Pick<MouseEvent, 'button' | 'target'>): boolean => {
    return event.button === 1 && !nestedScrollableTarget(root, event.target);
};

export const shouldRepinReleasedAutoFollow = (scrollingDown: boolean, atTrueBottom: boolean): boolean => {
    return scrollingDown || atTrueBottom;
};

const nestedScrollableCanConsumeUp = (root: HTMLElement, target: EventTarget | null): boolean => {
    const nested = nestedScrollableTarget(root, target);
    if (!nested) return false;
    return nested.scrollTop > 0;
};

export const useChatAutoFollow = ({
    currentSessionId,
    sessionMessageCount,
    sessionIsWorking,
    isMobile,
    onActiveTurnChange,
}: UseChatAutoFollowOptions): UseChatAutoFollowResult => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const [containerEl, setContainerEl] = React.useState<HTMLDivElement | null>(null);
    const lastSeenContainerRef = React.useRef<HTMLDivElement | null>(null);

    const [state, setState] = React.useState<AutoFollowState>('following');
    const [isOverflowing, setIsOverflowing] = React.useState(false);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [isFollowingProgrammatically, setIsFollowingProgrammatically] = React.useState(false);

    // `stateRef` is the single source of truth for follow vs released; the React
    // state above is a mirror for rendering. `released` means the user scrolled
    // up and away from the bottom.
    const stateRef = React.useRef<AutoFollowState>('following');
    const isMobileRef = React.useRef(isMobile);
    isMobileRef.current = isMobile;
    const sessionIsWorkingRef = React.useRef(sessionIsWorking);
    sessionIsWorkingRef.current = sessionIsWorking;
    // `settling` keeps passive follow alive for a short window after work stops
    // so the final content can land at the bottom.
    const settlingRef = React.useRef(false);
    const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const sessionMessageCountRef = React.useRef(sessionMessageCount);
    sessionMessageCountRef.current = sessionMessageCount;
    const currentSessionIdRef = React.useRef(currentSessionId);
    currentSessionIdRef.current = currentSessionId;

    const lastSessionIdRef = React.useRef<string | null>(null);

    // Programmatic-scroll marker: the bottom position we last
    // wrote and when. A scroll event whose scrollTop matches `top` within a few
    // px while still inside the TTL is OUR write, not the user's.
    const autoRef = React.useRef<{ top: number; time: number } | null>(null);
    const autoTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Timestamp until which a tracked height animation is in flight (see
    // ANIMATION_GUARD_MS). 0 = no animation guard active.
    const animationGuardUntilRef = React.useRef(0);

    // True while the native (Capacitor iOS) keyboard slide choreography is in
    // flight (between 'oc:keyboard-anim' and 'oc:keyboard-settled' from
    // useNativeMobileChrome). During that window the pinned content is moved by a
    // transform on the inner wrapper, so the ResizeObserver chase must stand down.
    const keyboardAnimRef = React.useRef(false);

    // Last observed scrollTop, used to derive scroll DIRECTION in the scroll
    // handler so the bottom-zone re-engage only fires when arriving at the bottom
    // by scrolling down — never when a user scrolling UP merely lands in the zone.
    const lastScrollTopRef = React.useRef(0);

    // Entry-stick window state (see ENTRY_STICK_* above).
    const entryStickRef = React.useRef(false);
    const entryStickQuietTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const entryStickCapTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const entryStickLastHeightRef = React.useRef(0);

    const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSaveRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const delayedRepinTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastUserReleaseAtRef = React.useRef(0);
    // When restoreSnapshot is invoked while ChatViewport is still hydrating
    // (skeleton rendered, no scroll container yet), we record the session here
    // so a follow-up effect can replay the restore once the container mounts.
    const pendingInitialRestoreRef = React.useRef<string | null>(null);

    const updateViewportAnchor = useViewportStore((s) => s.updateViewportAnchor);

    // Detect when the scroll container DOM element changes (mount, unmount, remount).
    // Without this, listener-attach effects would only ever bind to the element that
    // existed at the hook's first render, missing later mounts (e.g. after first send
    // promotes a draft session to a real chat with messages).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useLayoutEffect(() => {
        if (scrollRef.current !== lastSeenContainerRef.current) {
            lastSeenContainerRef.current = scrollRef.current;
            setContainerEl(scrollRef.current);
        }
    });

    // `active` is `working || settling`. Passive auto-follow
    // (the ResizeObserver re-pin and any non-forced scrollToBottom) only runs
    // while active. When the session is idle, content-size changes are layout
    // churn — virtualizer re-measurement, async tool/code rendering — NOT live
    // growth, so we must NOT yank the user to the bottom. Forcing this gate is
    // what stops the twitch when tall items (expanded tools) re-measure as the
    // user scrolls.
    const isActive = React.useCallback((): boolean => {
        return sessionIsWorkingRef.current || settlingRef.current;
    }, []);

    const setStateValue = React.useCallback((next: AutoFollowState) => {
        if (stateRef.current === next) return;
        stateRef.current = next;
        setState(next);
    }, []);

    // ── auto marker ────────────────────────────────────────────────────────
    const markAuto = React.useCallback((el: HTMLElement) => {
        autoRef.current = {
            top: Math.max(0, el.scrollHeight - el.clientHeight),
            time: now(),
        };
        if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
        autoTimerRef.current = setTimeout(() => {
            autoRef.current = null;
            autoTimerRef.current = null;
        }, AUTO_MARK_TTL_MS);
    }, []);

    const isAuto = React.useCallback((el: HTMLElement): boolean => {
        const a = autoRef.current;
        if (!a) return false;
        if (now() - a.time > AUTO_MARK_TTL_MS) {
            autoRef.current = null;
            return false;
        }
        return Math.abs(el.scrollTop - a.top) < AUTO_MATCH_TOLERANCE_PX;
    }, []);

    const isAnimationGuardActive = React.useCallback((): boolean => {
        return now() < animationGuardUntilRef.current;
    }, []);

    // ── entry-stick window ───────────────────────────────────────────────────
    const endEntryStick = React.useCallback(() => {
        entryStickRef.current = false;
        if (entryStickQuietTimerRef.current) {
            clearTimeout(entryStickQuietTimerRef.current);
            entryStickQuietTimerRef.current = null;
        }
        if (entryStickCapTimerRef.current) {
            clearTimeout(entryStickCapTimerRef.current);
            entryStickCapTimerRef.current = null;
        }
    }, []);

    // (Re)arm the quiescence timer: the window closes this long after the last
    // growth. Called once on begin and again on every growth-driven re-pin.
    const armEntryStickQuiet = React.useCallback(() => {
        if (entryStickQuietTimerRef.current) {
            clearTimeout(entryStickQuietTimerRef.current);
        }
        entryStickQuietTimerRef.current = setTimeout(() => {
            entryStickQuietTimerRef.current = null;
            endEntryStick();
        }, ENTRY_STICK_QUIESCENCE_MS);
    }, [endEntryStick]);

    const beginEntryStick = React.useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        entryStickRef.current = true;
        entryStickLastHeightRef.current = el.scrollHeight;
        armEntryStickQuiet();
        // Reset the absolute cap fresh on every entry (e.g. session switch) so a
        // stale cap from a previous open can't cut this window short.
        if (entryStickCapTimerRef.current) {
            clearTimeout(entryStickCapTimerRef.current);
        }
        entryStickCapTimerRef.current = setTimeout(() => {
            entryStickCapTimerRef.current = null;
            endEntryStick();
        }, ENTRY_STICK_MAX_MS);
    }, [armEntryStickQuiet, endEntryStick]);

    // ── overflow / scroll-to-bottom button ──────────────────────────────────
    const updateOverflowAndButton = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            setIsOverflowing(false);
            setShowScrollButton(false);
            return;
        }
        const overflowing = canScroll(container);
        setIsOverflowing(overflowing);
        if (!overflowing) {
            setShowScrollButton(false);
            return;
        }
        const showButton = stateRef.current === 'released' && !isNearBottom(container, isMobileRef.current);
        setShowScrollButton(showButton);
    }, []);

    const clearDelayedRepin = React.useCallback(() => {
        if (delayedRepinTimerRef.current !== null) {
            clearTimeout(delayedRepinTimerRef.current);
            delayedRepinTimerRef.current = null;
        }
    }, []);

    // ── core scroll primitives ───────────────────────────────────────────────
    const scrollToBottomNow = React.useCallback((behavior: ScrollBehavior) => {
        const el = scrollRef.current;
        if (!el) return;
        markAuto(el);
        if (behavior === 'smooth') {
            el.scrollTo({ top: el.scrollHeight, behavior });
            return;
        }
        // Direct `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`
        // and lands in the same frame — no visible catch-up animation.
        el.scrollTop = el.scrollHeight;
    }, [markAuto]);

    // `force` true = user-intent jump (clears released and always scrolls).
    // `force` false = passive follow (only while still following).
    const scrollToBottom = React.useCallback((force: boolean, behavior: ScrollBehavior = 'auto') => {
        const el = scrollRef.current;

        // Passive follow only while active (working/settling). Forced jumps
        // (send, go-to-bottom, session restore) always proceed.
        if (!force && !isActive()) return;

        if (force && stateRef.current !== 'following') {
            setStateValue('following');
        }
        if (!el) return;
        if (!force && stateRef.current !== 'following') return;

        const distance = distanceFromBottom(el);
        if (distance < AUTO_MATCH_TOLERANCE_PX) {
            // Already at the bottom; just refresh the auto marker so the next
            // scroll event is recognised as ours.
            markAuto(el);
            return;
        }
        scrollToBottomNow(force ? behavior : 'auto');
    }, [isActive, markAuto, scrollToBottomNow, setStateValue]);

    // User left the bottom — release auto-follow.
    const stop = React.useCallback(() => {
        clearDelayedRepin();
        const el = scrollRef.current;
        if (!el) return;
        if (!canScroll(el)) {
            setStateValue('following');
            return;
        }
        if (stateRef.current === 'released') return;
        lastUserReleaseAtRef.current = now();
        setStateValue('released');
        updateOverflowAndButton();
    }, [clearDelayedRepin, setStateValue, updateOverflowAndButton]);

    // ── public scroll API (mapped onto the primitives) ───────────────────────
    const goToBottom = React.useCallback((mode: 'instant' | 'smooth' = 'instant') => {
        clearDelayedRepin();
        lastUserReleaseAtRef.current = 0;
        scrollToBottom(true, mode === 'smooth' ? 'smooth' : 'auto');
    }, [clearDelayedRepin, scrollToBottom]);

    const scrollToBottomOnSend = React.useCallback(() => {
        // Single movement to the just-sent message. Force re-pins to the bottom
        // whether we were following or scrolled up; the content ResizeObserver
        // keeps us pinned as the optimistic message and its reply stream in.
        clearDelayedRepin();
        lastUserReleaseAtRef.current = 0;
        scrollToBottom(true);
    }, [clearDelayedRepin, scrollToBottom]);

    const releaseAutoFollow = React.useCallback(() => {
        clearDelayedRepin();
        lastUserReleaseAtRef.current = now();
        setStateValue('released');
        updateOverflowAndButton();
    }, [clearDelayedRepin, setStateValue, updateOverflowAndButton]);

    const releaseFromUserIntent = React.useCallback(() => {
        // A genuine user gesture (wheel/touch/key/scrollbar) cancels the entry
        // window immediately so we never fight the user's read position.
        endEntryStick();
        lastUserReleaseAtRef.current = now();
        stop();
    }, [endEntryStick, stop]);

    const scheduleRepinAfterGrace = React.useCallback((delayMs: number) => {
        if (delayedRepinTimerRef.current !== null) return;
        delayedRepinTimerRef.current = setTimeout(() => {
            delayedRepinTimerRef.current = null;
            const container = scrollRef.current;
            if (!container) return;
            if (stateRef.current !== 'released') return;
            if (!isNearBottom(container, isMobileRef.current)) return;
            setStateValue('following');
            scrollToBottom(true);
        }, Math.max(0, delayMs));
    }, [scrollToBottom, setStateValue]);

    // ── per-session snapshot persistence (kept; restore still goes to bottom) ─
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

    const restoreSnapshot = React.useCallback(async (): Promise<boolean> => {
        const sessionId = currentSessionIdRef.current;
        if (!sessionId) return false;

        const container = scrollRef.current;
        if (!container) {
            // ChatViewport not mounted yet (e.g., session still hydrating).
            // Record the request so the container-attach effect can replay it.
            pendingInitialRestoreRef.current = sessionId;
            setStateValue('following');
            return false;
        }
        pendingInitialRestoreRef.current = null;

        // Always return to the bottom on session switch. The content
        // ResizeObserver re-pins instantly as late
        // history measures in, so there is no smooth scroll-from-mid artifact.
        setStateValue('following');
        scrollToBottom(true);
        // Hold the bottom across late async growth (e.g. task/subagent child
        // session data landing a beat after entry) until content quiesces or the
        // user scrolls.
        beginEntryStick();
        updateOverflowAndButton();
        return false;
    }, [beginEntryStick, scrollToBottom, setStateValue, updateOverflowAndButton]);

    // ── session change ───────────────────────────────────────────────────────
    React.useEffect(() => {
        if (!currentSessionId || currentSessionId === lastSessionIdRef.current) {
            return;
        }
        lastSessionIdRef.current = currentSessionId;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        clearDelayedRepin();
        flushSave();
        autoRef.current = null;
        // Drop any pending restore request inherited from a different session.
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current !== currentSessionId) {
            pendingInitialRestoreRef.current = null;
        }
    }, [clearDelayedRepin, currentSessionId, flushSave]);

    // When work begins and we are still
    // following, pin to the bottom. When work stops, keep following alive for a
    // short settle window so the final content lands at the bottom, then go
    // idle (after which passive follow is disabled — see `isActive`).
    React.useEffect(() => {
        settlingRef.current = false;
        if (settleTimerRef.current) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        }

        if (sessionIsWorking) {
            if (stateRef.current === 'following') {
                scrollToBottom(true);
            }
            return;
        }

        settlingRef.current = true;
        settleTimerRef.current = setTimeout(() => {
            settlingRef.current = false;
            settleTimerRef.current = null;
        }, SETTLE_MS);
    }, [sessionIsWorking, scrollToBottom]);

    // Suppress the overlay scrollbar thumb only while we are actively following a
    // live stream (the thumb would otherwise jump on every instant re-pin). When
    // idle or released the scrollbar behaves normally. Stable: changes only when
    // follow-state or working-state flips, not on every frame.
    React.useEffect(() => {
        setIsFollowingProgrammatically(state === 'following' && sessionIsWorking);
    }, [state, sessionIsWorking]);

    // Replay a deferred restoreSnapshot once ChatViewport mounts.
    // useLayoutEffect ensures scroll position is set before the browser paints,
    // preventing a visible flash of content at the wrong scroll position.
    React.useLayoutEffect(() => {
        if (!containerEl) return;
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current === currentSessionId) {
            void restoreSnapshot();
        }
    }, [containerEl, currentSessionId, restoreSnapshot]);

    // ── scroll event handling ────────────────────────────────────────────────
    const handleScrollEvent = React.useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;

        const previousTop = lastScrollTopRef.current;
        lastScrollTopRef.current = el.scrollTop;
        const scrollingDown = el.scrollTop > previousTop + 0.5;

        updateOverflowAndButton();

        if (!canScroll(el)) {
            setStateValue('following');
            return;
        }

        // Within the bottom zone → (re-)pin to following. This is how scrolling
        // back DOWN to the bottom resumes auto-follow. Crucially, re-engage only
        // when the user arrives by scrolling down (or is already following, or is
        // essentially at the true bottom). A user scrolling UP that merely lands
        // in the bottom spacer zone must NOT be yanked back into follow — that is
        // the dead-zone fight that made small upward scrolls impossible while
        // content streams.
        if (isNearBottom(el, isMobileRef.current)) {
            const atTrueBottom = distanceFromBottom(el) <= AUTO_MATCH_TOLERANCE_PX;
            if (stateRef.current === 'released') {
                if (!shouldRepinReleasedAutoFollow(scrollingDown, atTrueBottom)) {
                    clearDelayedRepin();
                } else {
                    const elapsedSinceRelease = now() - lastUserReleaseAtRef.current;
                    if (elapsedSinceRelease < REPIN_GRACE_AFTER_RELEASE_MS) {
                        scheduleRepinAfterGrace(REPIN_GRACE_AFTER_RELEASE_MS - elapsedSinceRelease);
                    } else {
                        clearDelayedRepin();
                        setStateValue('following');
                    }
                }
            } else if (scrollingDown || stateRef.current === 'following' || atTrueBottom) {
                clearDelayedRepin();
                setStateValue('following');
            }
            queueSave();
            return;
        }
        clearDelayedRepin();

        // Our own geometry change (a programmatic write that landed at the bottom
        // but where content grew between the write and this event, OR a tracked
        // height animation in flight) — keep following, don't release.
        if (stateRef.current === 'following' && (isAuto(el) || isAnimationGuardActive())) {
            scrollToBottom(false);
            queueSave();
            return;
        }

        // Genuine user scroll away from the bottom.
        stop();
        queueSave();
    }, [clearDelayedRepin, isAnimationGuardActive, isAuto, queueSave, scheduleRepinAfterGrace, scrollToBottom, setStateValue, stop, updateOverflowAndButton]);

    React.useEffect(() => {
        const container = containerEl;
        if (!container) return;

        lastScrollTopRef.current = container.scrollTop;

        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY >= 0) return;
            if (nestedScrollableCanConsumeUp(container, event.target)) return;
            releaseFromUserIntent();
        };

        let touchLastY: number | null = null;
        const handleTouchStart = (event: TouchEvent) => {
            const touch = event.touches.item(0);
            touchLastY = touch ? touch.clientY : null;
        };
        const handleTouchMove = (event: TouchEvent) => {
            const touch = event.touches.item(0);
            if (!touch) {
                touchLastY = null;
                return;
            }
            const previousY = touchLastY;
            touchLastY = touch.clientY;
            if (previousY === null) return;
            const fingerDelta = touch.clientY - previousY;
            if (fingerDelta <= TOUCH_FINGER_DOWN_THRESHOLD) return;
            if (nestedScrollableCanConsumeUp(container, event.target)) return;
            releaseFromUserIntent();
        };
        const handleTouchEnd = () => {
            touchLastY = null;
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!isAutoFollowReleaseKey(event)) return;
            releaseFromUserIntent();
        };

        const handlePointerDown = (event: PointerEvent) => {
            if (!isMiddleButtonAutoScrollIntent(container, event)) return;
            releaseFromUserIntent();
        };

        const handleMouseDown = (event: MouseEvent) => {
            if (!isMiddleButtonAutoScrollIntent(container, event)) return;
            releaseFromUserIntent();
        };

        const handlePointerDownIntent = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!target.closest('[data-overlay-scrollbar-thumb]')) return;
            releaseFromUserIntent();
        };

        container.addEventListener('scroll', handleScrollEvent, { passive: true });
        container.addEventListener('wheel', handleWheel, { passive: true });
        container.addEventListener('touchstart', handleTouchStart, { passive: true });
        container.addEventListener('touchmove', handleTouchMove, { passive: true });
        container.addEventListener('touchend', handleTouchEnd, { passive: true });
        container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
        container.addEventListener('keydown', handleKeyDown);
        container.addEventListener('pointerdown', handlePointerDown, { passive: true });
        container.addEventListener('mousedown', handleMouseDown, { passive: true });
        if (typeof window !== 'undefined') {
            window.addEventListener('pointerdown', handlePointerDownIntent, true);
        }

        return () => {
            container.removeEventListener('scroll', handleScrollEvent);
            container.removeEventListener('wheel', handleWheel);
            container.removeEventListener('touchstart', handleTouchStart);
            container.removeEventListener('touchmove', handleTouchMove);
            container.removeEventListener('touchend', handleTouchEnd);
            container.removeEventListener('touchcancel', handleTouchEnd);
            container.removeEventListener('keydown', handleKeyDown);
            container.removeEventListener('pointerdown', handlePointerDown);
            container.removeEventListener('mousedown', handleMouseDown);
            if (typeof window !== 'undefined') {
                window.removeEventListener('pointerdown', handlePointerDownIntent, true);
            }
        };
    }, [containerEl, handleScrollEvent, releaseFromUserIntent]);

    // The heart of the follow behaviour: the content ResizeObserver fires after
    // layout and before paint, so re-pinning to the bottom here is invisible —
    // there is no "jump up then catch up". Observe both the container (composer
    // growth shrinks the viewport) and the inner content (streaming growth).
    React.useEffect(() => {
        const container = containerEl;
        if (!container || typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(() => {
            // Keyboard slide in flight: the container/composer resizes it reports
            // are part of the transform choreography — the settle handler does the
            // single deterministic re-pin, so chasing here would just fight it.
            if (keyboardAnimRef.current) {
                updateOverflowAndButton();
                return;
            }
            const el = scrollRef.current;
            if (el && !canScroll(el)) {
                setStateValue('following');
                updateOverflowAndButton();
                return;
            }
            updateOverflowAndButton();
            // Entry-stick window: on first session open, FORCE the bottom on
            // every growth so late async data (task/subagent child rows, code
            // highlight, mermaid) can't strand the viewport mid-history. Force
            // overrides any false `released` from the growth itself; only a real
            // user gesture clears the window (releaseFromUserIntent).
            if (entryStickRef.current && el) {
                const grew = el.scrollHeight > entryStickLastHeightRef.current + 1;
                entryStickLastHeightRef.current = el.scrollHeight;
                scrollToBottom(true);
                if (grew) armEntryStickQuiet();
                return;
            }
            // Idle resize = layout churn (virtualizer re-measurement, async
            // tool/code rendering), NOT live growth. Never re-pin when idle, or
            // tall items re-measuring as the user scrolls cause an endless
            // scroll-to-bottom/re-measure twitch.
            if (!isActive()) return;
            if (stateRef.current !== 'following') return;
            scrollToBottom(false);
        });
        observer.observe(container);
        const inner = container.firstElementChild;
        if (inner instanceof Element) {
            observer.observe(inner);
        }
        return () => observer.disconnect();
    }, [armEntryStickQuiet, containerEl, isActive, scrollToBottom, setStateValue, updateOverflowAndButton]);

    // ── native keyboard transitions (Capacitor choreography) ────────────────
    // The chat scroller gets NO transforms during the keyboard transition:
    // transforming the scroll container (or its content) forces WebKit to
    // rebuild the composited scrolling layers, which stalls for seconds on
    // long chats. Instead the chat repositions with instant snaps that hide
    // behind the keyboard itself:
    //   show: content stays put while the keyboard/composer slide over it; the
    //         settled event (shell layout snap) does ONE instant re-pin.
    //   hide: the shell layout is restored up-front — the scrollTop clamp
    //         happens while the keyboard still covers that region — and the
    //         settled event re-pins once at the end.
    // During the window we only guard the scroll heuristics and the observer
    // chase. These events never fire outside the Capacitor app.
    React.useEffect(() => {
        if (typeof window === 'undefined') return;

        const handleKeyboardAnim = (event: Event) => {
            const detail = (event as CustomEvent<{ phase: 'show' | 'hide'; slide: number; durationMs: number; easing: string }>).detail;
            if (!detail) return;
            keyboardAnimRef.current = true;
            // The clamp/resize during the choreography can dispatch scroll events
            // that land away from the auto marker — never read those as a user
            // scroll-away.
            animationGuardUntilRef.current = now() + detail.durationMs + ANIMATION_GUARD_MS;
        };

        const handleKeyboardSettled = () => {
            keyboardAnimRef.current = false;
            const el = scrollRef.current;
            if (!el) {
                updateOverflowAndButton();
                return;
            }
            // Single deterministic re-pin, same task as the layout swap → lands
            // before paint. (scrollToBottomNow, not scrollToBottom: this must not
            // be gated on working/settling — the keyboard resize is a viewport
            // change, not content growth.)
            if (stateRef.current === 'following' && canScroll(el)) {
                scrollToBottomNow('auto');
            }
            updateOverflowAndButton();
        };

        window.addEventListener('oc:keyboard-anim', handleKeyboardAnim);
        window.addEventListener('oc:keyboard-settled', handleKeyboardSettled);
        return () => {
            window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
            window.removeEventListener('oc:keyboard-settled', handleKeyboardSettled);
            keyboardAnimRef.current = false;
        };
    }, [scrollToBottomNow, updateOverflowAndButton]);

    React.useEffect(() => {
        updateOverflowAndButton();
    }, [sessionMessageCount, updateOverflowAndButton]);

    const notifyContentChange = React.useCallback((reason?: ContentChangeReason) => {
        // A tracked height animation (e.g. Thinking auto-collapse) opens a guard
        // window so its transient geometry / async scroll events are not misread
        // as a user scroll-away. Real gestures still release through
        // releaseFromUserIntent, so the user can always scroll up freely.
        if (reason === 'animation') {
            animationGuardUntilRef.current = now() + ANIMATION_GUARD_MS;
        }
        updateOverflowAndButton();
        // Entry-stick window: late structural growth (notably the task/subagent
        // summary landing from the child session — ToolPart emits 'structural'
        // here) must keep us pinned and refresh the quiescence timer, even though
        // the session is idle.
        if (entryStickRef.current) {
            scrollToBottom(true);
            armEntryStickQuiet();
            return;
        }
        if (stateRef.current === 'following') {
            scrollToBottom(false);
        }
    }, [armEntryStickQuiet, scrollToBottom, updateOverflowAndButton]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const cached = animationHandlersRef.current.get(messageId);
        if (cached) return cached;

        const kick = () => {
            if (stateRef.current === 'following') {
                scrollToBottom(false);
            }
        };

        const handlers: AnimationHandlers = {
            onChunk: kick,
            onComplete: () => {
                updateOverflowAndButton();
            },
            onStreamingCandidate: () => {},
            onAnimationStart: () => {},
            onAnimatedHeightChange: kick,
            onReservationCancelled: () => {},
            onReasoningBlock: () => {},
        };
        animationHandlersRef.current.set(messageId, handlers);
        return handlers;
    }, [scrollToBottom, updateOverflowAndButton]);

    React.useEffect(() => {
        return () => {
            clearDelayedRepin();
            if (autoTimerRef.current) {
                clearTimeout(autoTimerRef.current);
                autoTimerRef.current = null;
            }
            if (settleTimerRef.current) {
                clearTimeout(settleTimerRef.current);
                settleTimerRef.current = null;
            }
            endEntryStick();
            flushSave();
            if (saveTimerRef.current !== null) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, [clearDelayedRepin, endEntryStick, flushSave]);

    React.useEffect(() => {
        if (!onActiveTurnChange) return;
        const container = containerEl;
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
    }, [containerEl, onActiveTurnChange]);

    return {
        scrollRef,
        state,
        isPinned: state === 'following',
        isOverflowing,
        isFollowingProgrammatically,
        showScrollButton,
        notifyContentChange,
        getAnimationHandlers,
        goToBottom,
        scrollToBottomOnSend,
        releaseAutoFollow,
        saveSnapshotNow,
        restoreSnapshot,
    };
};
