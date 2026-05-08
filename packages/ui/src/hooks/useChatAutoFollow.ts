import React from 'react';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import { useViewportStore, type SessionMemoryState } from '@/sync/viewport-store';

export type AutoFollowState = 'following' | 'released';

export type ContentChangeReason = 'text' | 'structural' | 'permission';

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
    releaseAutoFollow: () => void;
    saveSnapshotNow: () => void;
    restoreSnapshot: () => Promise<boolean>;
}

const BOTTOM_SPACER_DESKTOP_VH = 0.10;
const BOTTOM_SPACER_MOBILE_PX = 40;
const PROGRAMMATIC_WRITE_WINDOW_MS = 200;
const SAVE_DEBOUNCE_MS = 150;
const LERP = 0.18;
const SETTLE_EPSILON = 0.5;
const SETTLE_FRAMES = 4;
const TOUCH_FINGER_DOWN_THRESHOLD = 2;
const SETTLE_BURST_DURATION_MS = 280;
const REPIN_GRACE_AFTER_RELEASE_MS = 1200;

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

const isNearBottom = (el: HTMLElement, isMobile: boolean): boolean => {
    return distanceFromBottom(el) <= computeBottomZoneThreshold(isMobile, el);
};

const isReleaseKey = (event: KeyboardEvent): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
        return false;
    }
    switch (event.key) {
        case 'ArrowUp':
        case 'PageUp':
        case 'Home':
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

const nestedScrollableCanConsumeUp = (root: HTMLElement, target: EventTarget | null): boolean => {
    const nested = nestedScrollableTarget(root, target);
    if (!nested) return false;
    return nested.scrollTop > 0;
};

const isAtBottomSnapshot = (snapshot: NonNullable<SessionMemoryState['scrollPosition']>, isMobile: boolean): boolean => {
    const max = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
    if (max <= 0) return true;
    const threshold = computeBottomZoneThreshold(isMobile, null);
    return max - snapshot.scrollTop <= threshold;
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

    const stateRef = React.useRef<AutoFollowState>('following');
    const sessionWorkingRef = React.useRef(sessionIsWorking);
    sessionWorkingRef.current = sessionIsWorking;
    const sessionMessageCountRef = React.useRef(sessionMessageCount);
    sessionMessageCountRef.current = sessionMessageCount;
    const currentSessionIdRef = React.useRef(currentSessionId);
    currentSessionIdRef.current = currentSessionId;

    const lastSessionIdRef = React.useRef<string | null>(null);
    const programmaticWriteUntilRef = React.useRef(0);
    const followRafRef = React.useRef<number | null>(null);
    const settledFramesRef = React.useRef(0);
    const lastScrollTopRef = React.useRef(0);
    const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSaveRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const settleBurstRafRef = React.useRef<number | null>(null);
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

    const setStateValue = React.useCallback((next: AutoFollowState) => {
        if (stateRef.current === next) return;
        stateRef.current = next;
        setState(next);
    }, []);

    const markProgrammaticWrite = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        programmaticWriteUntilRef.current = now + PROGRAMMATIC_WRITE_WINDOW_MS;
    }, []);

    const isInProgrammaticWindow = React.useCallback(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return now < programmaticWriteUntilRef.current;
    }, []);

    const stopFollowLoop = React.useCallback(() => {
        if (followRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(followRafRef.current);
        }
        followRafRef.current = null;
        settledFramesRef.current = 0;
        setIsFollowingProgrammatically(false);
    }, []);

    const tickFollow = React.useCallback(() => {
        followRafRef.current = null;
        const container = scrollRef.current;
        if (!container) {
            stopFollowLoop();
            return;
        }
        if (stateRef.current !== 'following' || !sessionWorkingRef.current) {
            stopFollowLoop();
            return;
        }

        const target = Math.max(0, container.scrollHeight - container.clientHeight);
        const current = container.scrollTop;
        const delta = target - current;

        if (Math.abs(delta) <= SETTLE_EPSILON) {
            if (current !== target) {
                markProgrammaticWrite();
                container.scrollTop = target;
                lastScrollTopRef.current = target;
            }
            settledFramesRef.current += 1;
            if (settledFramesRef.current >= SETTLE_FRAMES) {
                stopFollowLoop();
                return;
            }
            followRafRef.current = window.requestAnimationFrame(tickFollow);
            return;
        }

        settledFramesRef.current = 0;
        const next = current + delta * LERP;
        markProgrammaticWrite();
        container.scrollTop = next;
        lastScrollTopRef.current = container.scrollTop;
        followRafRef.current = window.requestAnimationFrame(tickFollow);
    }, [markProgrammaticWrite, stopFollowLoop]);

    const startFollowLoop = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        if (followRafRef.current !== null) return;
        if (stateRef.current !== 'following' || !sessionWorkingRef.current) return;
        settledFramesRef.current = 0;
        setIsFollowingProgrammatically(true);
        followRafRef.current = window.requestAnimationFrame(tickFollow);
    }, [tickFollow]);

    const writeScrollTopInstant = React.useCallback((target: number) => {
        const container = scrollRef.current;
        if (!container) return;
        const max = Math.max(0, container.scrollHeight - container.clientHeight);
        const clamped = Math.max(0, Math.min(target, max));
        markProgrammaticWrite();
        container.scrollTop = clamped;
        lastScrollTopRef.current = container.scrollTop;
    }, [markProgrammaticWrite]);

    const stopSettleBurst = React.useCallback(() => {
        if (settleBurstRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(settleBurstRafRef.current);
        }
        settleBurstRafRef.current = null;
    }, []);

    const startSettleBurst = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        stopSettleBurst();
        const until = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + SETTLE_BURST_DURATION_MS;
        const tick = () => {
            settleBurstRafRef.current = null;
            if (stateRef.current !== 'following') return;
            const c = scrollRef.current;
            if (!c) return;
            const target = Math.max(0, c.scrollHeight - c.clientHeight);
            if (Math.abs(c.scrollTop - target) > SETTLE_EPSILON) {
                markProgrammaticWrite();
                c.scrollTop = target;
                lastScrollTopRef.current = target;
            }
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now < until) {
                settleBurstRafRef.current = window.requestAnimationFrame(tick);
            }
        };
        settleBurstRafRef.current = window.requestAnimationFrame(tick);
    }, [markProgrammaticWrite, stopSettleBurst]);

    const releaseAutoFollow = React.useCallback(() => {
        stopFollowLoop();
        stopSettleBurst();
        lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
        setStateValue('released');
    }, [setStateValue, stopFollowLoop, stopSettleBurst]);

    const releaseFromUserIntent = React.useCallback(() => {
        if (stateRef.current === 'following') {
            stopFollowLoop();
            stopSettleBurst();
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
            setStateValue('released');
        } else {
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
        }
    }, [setStateValue, stopFollowLoop, stopSettleBurst]);

    const goToBottom = React.useCallback((mode: 'instant' | 'smooth' = 'instant') => {
        const container = scrollRef.current;
        setStateValue('following');
        lastUserReleaseAtRef.current = 0;
        if (!container) return;
        if (mode === 'smooth' && sessionWorkingRef.current) {
            startFollowLoop();
            return;
        }
        const target = Math.max(0, container.scrollHeight - container.clientHeight);
        writeScrollTopInstant(target);
        if (sessionWorkingRef.current) {
            startFollowLoop();
        } else {
            startSettleBurst();
        }
    }, [setStateValue, startFollowLoop, startSettleBurst, writeScrollTopInstant]);

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

        const saved = useViewportStore.getState().sessionMemoryState.get(sessionId)?.scrollPosition;

        if (!saved || isAtBottomSnapshot(saved, isMobile)) {
            setStateValue('following');
            lastUserReleaseAtRef.current = 0;
            const target = Math.max(0, container.scrollHeight - container.clientHeight);
            writeScrollTopInstant(target);
            if (sessionWorkingRef.current) {
                startFollowLoop();
            }
            startSettleBurst();
            return false;
        }

        const savedMaxScroll = Math.max(0, saved.scrollHeight - saved.clientHeight);
        const ratio = savedMaxScroll > 0 ? saved.scrollTop / savedMaxScroll : 0;
        const currentMaxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.round(ratio * currentMaxScroll);

        setStateValue('released');
        writeScrollTopInstant(targetTop);

        const memState = useViewportStore.getState().sessionMemoryState.get(sessionId);
        updateViewportAnchor(sessionId, memState?.viewportAnchor ?? 0, {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        });

        return true;
    }, [isMobile, setStateValue, startFollowLoop, startSettleBurst, updateViewportAnchor, writeScrollTopInstant]);

    React.useEffect(() => {
        if (!currentSessionId || currentSessionId === lastSessionIdRef.current) {
            return;
        }
        lastSessionIdRef.current = currentSessionId;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        flushSave();
        stopFollowLoop();
        stopSettleBurst();
        markProgrammaticWrite();
        // Drop any pending restore request inherited from a different session.
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current !== currentSessionId) {
            pendingInitialRestoreRef.current = null;
        }
    }, [currentSessionId, flushSave, markProgrammaticWrite, stopFollowLoop, stopSettleBurst]);

    React.useEffect(() => {
        if (!sessionIsWorking) {
            stopFollowLoop();
        } else if (stateRef.current === 'following') {
            startFollowLoop();
        }
    }, [sessionIsWorking, startFollowLoop, stopFollowLoop]);

    // Replay a deferred restoreSnapshot once ChatViewport mounts.
    React.useEffect(() => {
        if (!containerEl) return;
        if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current === currentSessionId) {
            void restoreSnapshot();
        }
    }, [containerEl, currentSessionId, restoreSnapshot]);

    const updateOverflowAndButton = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            setIsOverflowing(false);
            setShowScrollButton(false);
            return;
        }
        const overflowing = container.scrollHeight > container.clientHeight + 1;
        setIsOverflowing(overflowing);
        if (!overflowing) {
            setShowScrollButton(false);
            return;
        }
        const showButton = stateRef.current === 'released' && !isNearBottom(container, isMobile);
        setShowScrollButton(showButton);
    }, [isMobile]);

    const handleScrollEvent = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;

        const programmatic = isInProgrammaticWindow();
        const currentTop = container.scrollTop;
        const previousTop = lastScrollTopRef.current;
        lastScrollTopRef.current = currentTop;

        updateOverflowAndButton();

        if (programmatic) {
            return;
        }

        if (currentTop < previousTop && stateRef.current === 'following') {
            stopFollowLoop();
            stopSettleBurst();
            lastUserReleaseAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
            setStateValue('released');
        }

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const inGrace = (now - lastUserReleaseAtRef.current) < REPIN_GRACE_AFTER_RELEASE_MS;
        if (stateRef.current === 'released' && isNearBottom(container, isMobile) && !inGrace) {
            setStateValue('following');
            if (sessionWorkingRef.current) {
                startFollowLoop();
            }
        }

        queueSave();
    }, [
        isInProgrammaticWindow,
        isMobile,
        queueSave,
        setStateValue,
        startFollowLoop,
        stopFollowLoop,
        stopSettleBurst,
        updateOverflowAndButton,
    ]);

    React.useEffect(() => {
        const container = containerEl;
        if (!container) return;

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
            if (!isReleaseKey(event)) return;
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
            if (typeof window !== 'undefined') {
                window.removeEventListener('pointerdown', handlePointerDownIntent, true);
            }
        };
    }, [containerEl, handleScrollEvent, releaseFromUserIntent]);

    React.useEffect(() => {
        const container = containerEl;
        if (!container || typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(() => {
            updateOverflowAndButton();
            if (stateRef.current === 'following' && sessionWorkingRef.current) {
                startFollowLoop();
            }
        });
        observer.observe(container);
        const inner = container.firstElementChild;
        if (inner instanceof Element) {
            observer.observe(inner);
        }
        return () => observer.disconnect();
    }, [containerEl, startFollowLoop, updateOverflowAndButton]);

    React.useEffect(() => {
        updateOverflowAndButton();
    }, [sessionMessageCount, updateOverflowAndButton]);

    const notifyContentChange = React.useCallback((_reason?: ContentChangeReason) => {
        void _reason;
        updateOverflowAndButton();
        if (stateRef.current === 'following' && sessionWorkingRef.current) {
            startFollowLoop();
        }
    }, [startFollowLoop, updateOverflowAndButton]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const cached = animationHandlersRef.current.get(messageId);
        if (cached) return cached;

        const kick = () => {
            if (stateRef.current === 'following' && sessionWorkingRef.current) {
                startFollowLoop();
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
    }, [startFollowLoop, updateOverflowAndButton]);

    React.useEffect(() => {
        return () => {
            stopFollowLoop();
            stopSettleBurst();
            flushSave();
            if (saveTimerRef.current !== null) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, [flushSave, stopFollowLoop, stopSettleBurst]);

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
        releaseAutoFollow,
        saveSnapshotNow,
        restoreSnapshot,
    };
};
