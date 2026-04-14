import React from 'react';
import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import {
    isNearBottom,
    normalizeWheelDelta,
    shouldPauseAutoScrollOnWheel,
} from '@/components/chat/lib/scroll/scrollIntent';

import { useScrollEngine } from './useScrollEngine';

export type ContentChangeReason = 'text' | 'structural' | 'permission';

interface SessionMemoryState {
    viewportAnchor: number;
    isStreaming: boolean;
    lastAccessedAt: number;
    backgroundMessageCount: number;
    totalAvailableMessages?: number;
    hasMoreAbove?: boolean;
    streamStartTime?: number;
    isZombie?: boolean;
}

interface UseChatScrollManagerOptions {
    currentSessionId: string | null;
    sessionMessageCount: number;
    sessionPermissions: unknown[];
    sessionIsWorking: boolean;
    sessionMemoryState: Map<string, SessionMemoryState>;
    updateViewportAnchor: (sessionId: string, anchor: number) => void;
    isSyncing: boolean;
    isMobile: boolean;
    chatRenderMode?: 'sorted' | 'live';
    onActiveTurnChange?: (turnId: string | null) => void;
}

export interface AnimationHandlers {
    onChunk: () => void;
    onComplete: () => void;
    onStreamingCandidate?: () => void;
    onAnimationStart?: () => void;
    onReservationCancelled?: () => void;
    onReasoningBlock?: () => void;
    onAnimatedHeightChange?: (height: number) => void;
}

type FollowMode = 'none' | 'smooth';

type AutoScrollMarker = {
    top: number;
    at: number;
};

interface UseChatScrollManagerResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    handleMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    showScrollButton: boolean;
    prepareForBottomResume: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollToBottom: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollToPosition: (position: number, options?: { instant?: boolean }) => void;
    releasePinnedScroll: () => void;
    isPinned: boolean;
    isOverflowing: boolean;
    isProgrammaticFollowActive: boolean;
}

const PROGRAMMATIC_SCROLL_SUPPRESS_MS = 200;
// Threshold for re-pinning: 10% of container height (matches bottom spacer)
const PIN_THRESHOLD_RATIO = 0.10;
const VIEWPORT_ANCHOR_MIN_UPDATE_MS = 150;

export const useChatScrollManager = ({
    currentSessionId,
    sessionMessageCount,
    sessionIsWorking,
    updateViewportAnchor,
    isSyncing,
    isMobile,
    onActiveTurnChange,
}: UseChatScrollManagerOptions): UseChatScrollManagerResult => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const scrollEngine = useScrollEngine({ containerRef: scrollRef, isMobile });

    const getPinThreshold = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container || container.clientHeight <= 0) {
            return 0;
        }
        const raw = container.clientHeight * PIN_THRESHOLD_RATIO;
        return Math.max(24, Math.min(200, raw));
    }, []);

    const getAutoFollowThreshold = React.useCallback(() => {
        return getPinThreshold();
    }, [getPinThreshold]);

    const getAutoFollowSnapThreshold = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container || container.clientHeight <= 0) {
            return 96;
        }

        const raw = container.clientHeight * 0.2;
        return Math.max(72, Math.min(192, raw));
    }, []);

    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [isPinned, setIsPinned] = React.useState(true);
    const [isOverflowing, setIsOverflowing] = React.useState(false);
    const showScrollButtonRef = React.useRef(false);
    const isOverflowingRef = React.useRef(false);

    const lastSessionIdRef = React.useRef<string | null>(null);
    const isPinnedRef = React.useRef(true);
    const lastScrollTopRef = React.useRef<number>(0);
    const touchLastYRef = React.useRef<number | null>(null);
    const pinnedSyncRafRef = React.useRef<number | null>(null);
    const followModeRef = React.useRef<FollowMode>('none');
    const autoScrollMarkerRef = React.useRef<AutoScrollMarker | null>(null);
    const viewportAnchorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingViewportAnchorRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const lastViewportAnchorRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const lastViewportAnchorWriteAtRef = React.useRef<number>(0);

    const markAutoScroll = React.useCallback((top: number) => {
        autoScrollMarkerRef.current = {
            top,
            at: Date.now(),
        };
    }, []);

    const isMarkedAutoScroll = React.useCallback((scrollTop: number) => {
        const marker = autoScrollMarkerRef.current;
        if (!marker) {
            return false;
        }

        if (Date.now() - marker.at > PROGRAMMATIC_SCROLL_SUPPRESS_MS) {
            autoScrollMarkerRef.current = null;
            return false;
        }

        if (Math.abs(scrollTop - marker.top) > 2) {
            return false;
        }

        return true;
    }, []);

    const getDistanceFromBottom = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) return 0;
        return container.scrollHeight - container.scrollTop - container.clientHeight;
    }, []);

    const updatePinnedState = React.useCallback((newPinned: boolean) => {
        if (isPinnedRef.current !== newPinned) {
            isPinnedRef.current = newPinned;
            setIsPinned(newPinned);
        }
    }, []);

    const setShowScrollButtonState = React.useCallback((next: boolean) => {
        showScrollButtonRef.current = next;
        setShowScrollButton((previous) => (previous === next ? previous : next));
    }, []);

    const setIsOverflowingState = React.useCallback((next: boolean) => {
        isOverflowingRef.current = next;
        setIsOverflowing((previous) => (previous === next ? previous : next));
    }, []);

    const setFollowMode = React.useCallback((next: FollowMode) => {
        followModeRef.current = next;
    }, []);

    const shouldSkipLiveContentSync = React.useCallback(() => {
        return !isPinnedRef.current && showScrollButtonRef.current && isOverflowingRef.current;
    }, []);

    const scrollToBottomInternal = React.useCallback((options?: { instant?: boolean; followBottom?: boolean }) => {
        const container = scrollRef.current;
        if (!container) return;

        const bottom = container.scrollHeight - container.clientHeight;
        markAutoScroll(Math.max(0, bottom));
        scrollEngine.scrollToPosition(Math.max(0, bottom), {
            ...options,
            persistFollow: Boolean(options?.followBottom && sessionIsWorking),
        });
    }, [markAutoScroll, scrollEngine, sessionIsWorking]);

    const scrollPinnedToBottom = React.useCallback((distanceFromBottom: number) => {
        if (sessionIsWorking) {
            if (followModeRef.current === 'smooth' || scrollEngine.isFollowingBottom) {
                scrollToBottomInternal({ followBottom: true });
                return;
            }

            if (distanceFromBottom > getAutoFollowSnapThreshold()) {
                scrollToBottomInternal({ instant: true });
                return;
            }

            setFollowMode('smooth');
            scrollToBottomInternal({ followBottom: true });
            return;
        }

        if (followModeRef.current === 'smooth' || scrollEngine.isFollowingBottom) {
            scrollToBottomInternal({ followBottom: true });
            return;
        }

        setFollowMode('none');
        scrollToBottomInternal({ instant: true });
    }, [getAutoFollowSnapThreshold, scrollEngine.isFollowingBottom, scrollToBottomInternal, sessionIsWorking, setFollowMode]);

    const updateScrollButtonVisibility = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            setShowScrollButtonState(false);
            setIsOverflowingState(false);
            return;
        }

        const hasScrollableContent = container.scrollHeight > container.clientHeight;
        setIsOverflowingState(hasScrollableContent);
        if (!hasScrollableContent) {
            setShowScrollButtonState(false);
            return;
        }

        // Show scroll button when scrolled above the 10vh threshold
        const distanceFromBottom = getDistanceFromBottom();
        setShowScrollButtonState(!isNearBottom(distanceFromBottom, getPinThreshold()));
    }, [getDistanceFromBottom, getPinThreshold, setIsOverflowingState, setShowScrollButtonState]);

    const syncPinnedStateAndIndicators = React.useCallback(() => {
        pinnedSyncRafRef.current = null;
        updateScrollButtonVisibility();
        if (!isPinnedRef.current) {
            setFollowMode('none');
            return;
        }

        const distanceFromBottom = getDistanceFromBottom();
        if (sessionIsWorking) {
            if (distanceFromBottom <= getAutoFollowThreshold()) {
                return;
            }

            scrollPinnedToBottom(distanceFromBottom);
            return;
        }

        if (distanceFromBottom <= getAutoFollowThreshold()) {
            if (followModeRef.current !== 'smooth') {
                setFollowMode('none');
            }
            return;
        }

        if (distanceFromBottom > getAutoFollowThreshold()) {
            scrollPinnedToBottom(distanceFromBottom);
        }
    }, [getAutoFollowThreshold, getDistanceFromBottom, scrollPinnedToBottom, sessionIsWorking, setFollowMode, updateScrollButtonVisibility]);

    const schedulePinnedStateAndIndicators = React.useCallback(() => {
        if (typeof window === 'undefined') {
            syncPinnedStateAndIndicators();
            return;
        }
        if (pinnedSyncRafRef.current !== null) {
            return;
        }
        pinnedSyncRafRef.current = window.requestAnimationFrame(() => {
            syncPinnedStateAndIndicators();
        });
    }, [syncPinnedStateAndIndicators]);

    const flushViewportAnchor = React.useCallback(() => {
        if (viewportAnchorTimerRef.current !== null) {
            clearTimeout(viewportAnchorTimerRef.current);
            viewportAnchorTimerRef.current = null;
        }

        const pending = pendingViewportAnchorRef.current;
        if (!pending) {
            return;
        }

        const lastPersisted = lastViewportAnchorRef.current;
        if (lastPersisted && lastPersisted.sessionId === pending.sessionId && lastPersisted.anchor === pending.anchor) {
            pendingViewportAnchorRef.current = null;
            return;
        }

        updateViewportAnchor(pending.sessionId, pending.anchor);
        lastViewportAnchorRef.current = pending;
        pendingViewportAnchorRef.current = null;
        lastViewportAnchorWriteAtRef.current = Date.now();
    }, [updateViewportAnchor]);

    const queueViewportAnchor = React.useCallback((sessionId: string, anchor: number) => {
        const lastPersisted = lastViewportAnchorRef.current;
        if (lastPersisted && lastPersisted.sessionId === sessionId && lastPersisted.anchor === anchor) {
            return;
        }

        pendingViewportAnchorRef.current = { sessionId, anchor };
        const now = Date.now();
        const elapsed = now - lastViewportAnchorWriteAtRef.current;
        if (elapsed >= VIEWPORT_ANCHOR_MIN_UPDATE_MS) {
            flushViewportAnchor();
            return;
        }

        if (viewportAnchorTimerRef.current !== null) {
            return;
        }

        viewportAnchorTimerRef.current = setTimeout(() => {
            viewportAnchorTimerRef.current = null;
            flushViewportAnchor();
        }, VIEWPORT_ANCHOR_MIN_UPDATE_MS - elapsed);
    }, [flushViewportAnchor]);

    const scrollToPosition = React.useCallback((position: number, options?: { instant?: boolean }) => {
        const container = scrollRef.current;
        if (!container) return;

        markAutoScroll(Math.max(0, position));
        scrollEngine.scrollToPosition(Math.max(0, position), options);
    }, [markAutoScroll, scrollEngine]);

    const prepareForBottomResume = React.useCallback(() => {
        updatePinnedState(true);
        setFollowMode(sessionIsWorking ? 'smooth' : 'none');
        setShowScrollButtonState(false);
    }, [sessionIsWorking, setFollowMode, setShowScrollButtonState, updatePinnedState]);

    const scrollToBottom = React.useCallback((options?: { instant?: boolean; force?: boolean; followBottom?: boolean }) => {
        const container = scrollRef.current;
        if (!container) return;

        prepareForBottomResume();
        scrollToBottomInternal(options);
    }, [prepareForBottomResume, scrollToBottomInternal]);

    const releasePinnedScroll = React.useCallback(() => {
        scrollEngine.cancelFollow();
        setFollowMode('none');
        updatePinnedState(false);
        schedulePinnedStateAndIndicators();
    }, [schedulePinnedStateAndIndicators, scrollEngine, setFollowMode, updatePinnedState]);

    const handleScrollEvent = React.useCallback((event?: Event) => {
        const container = scrollRef.current;
        if (!container || !currentSessionId) {
            return;
        }

        const isProgrammatic = isMarkedAutoScroll(container.scrollTop);
        if (isProgrammatic) {
            autoScrollMarkerRef.current = null;
        }

        scrollEngine.handleScroll();
        schedulePinnedStateAndIndicators();

        // Handle pin/unpin logic
        const currentScrollTop = container.scrollTop;
        const scrollingUp = currentScrollTop < lastScrollTopRef.current;

        if (event?.isTrusted && !isProgrammatic) {
            if (scrollingUp && isPinnedRef.current) {
                setFollowMode('none');
                updatePinnedState(false);
            }
        }

        // Re-pin at bottom should always work (even momentum scroll)
        if (!isPinnedRef.current) {
            const distanceFromBottom = getDistanceFromBottom();
            if (distanceFromBottom <= getPinThreshold()) {
                setFollowMode(sessionIsWorking ? 'smooth' : 'none');
                updatePinnedState(true);
            }
        }

        lastScrollTopRef.current = currentScrollTop;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const position = (scrollTop + clientHeight / 2) / Math.max(scrollHeight, 1);
        const estimatedIndex = Math.floor(position * sessionMessageCount);
        queueViewportAnchor(currentSessionId, estimatedIndex);
    }, [
        currentSessionId,
        getDistanceFromBottom,
        getPinThreshold,
        isMarkedAutoScroll,
        queueViewportAnchor,
        schedulePinnedStateAndIndicators,
        scrollEngine,
        setFollowMode,
        sessionMessageCount,
        sessionIsWorking,
        updatePinnedState,
    ]);

    const handleWheelIntent = React.useCallback((event: WheelEvent) => {
        const container = scrollRef.current;
        if (!container) {
            return;
        }

        const delta = normalizeWheelDelta({
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            rootHeight: container.clientHeight,
        });

        if (isPinnedRef.current && shouldPauseAutoScrollOnWheel({
            root: container,
            target: event.target,
            delta,
        })) {
            scrollEngine.cancelFollow();
            setFollowMode('none');
            updatePinnedState(false);
        }
    }, [scrollEngine, setFollowMode, updatePinnedState]);

    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const handleTouchStartIntent = (event: TouchEvent) => {
            const touch = event.touches.item(0);
            touchLastYRef.current = touch ? touch.clientY : null;
        };

        const handleTouchMoveIntent = (event: TouchEvent) => {
            const touch = event.touches.item(0);
            if (!touch) {
                touchLastYRef.current = null;
                return;
            }

            const previousY = touchLastYRef.current;
            touchLastYRef.current = touch.clientY;
            if (previousY === null || !isPinnedRef.current) {
                return;
            }

            const fingerDelta = touch.clientY - previousY;
            if (Math.abs(fingerDelta) < 2) {
                return;
            }

            const syntheticWheelDelta = -fingerDelta;
            if (syntheticWheelDelta >= 0) {
                return;
            }

            if (shouldPauseAutoScrollOnWheel({
                root: container,
                target: event.target,
                delta: syntheticWheelDelta,
            })) {
                scrollEngine.cancelFollow();
                setFollowMode('none');
                updatePinnedState(false);
            }
        };

        const handleTouchEndIntent = () => {
            touchLastYRef.current = null;
        };

        container.addEventListener('scroll', handleScrollEvent as EventListener, { passive: true });
        container.addEventListener('touchstart', handleTouchStartIntent as EventListener, { passive: true });
        container.addEventListener('touchmove', handleTouchMoveIntent as EventListener, { passive: true });
        container.addEventListener('touchend', handleTouchEndIntent as EventListener, { passive: true });
        container.addEventListener('touchcancel', handleTouchEndIntent as EventListener, { passive: true });
        container.addEventListener('wheel', handleWheelIntent as EventListener, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScrollEvent as EventListener);
            container.removeEventListener('touchstart', handleTouchStartIntent as EventListener);
            container.removeEventListener('touchmove', handleTouchMoveIntent as EventListener);
            container.removeEventListener('touchend', handleTouchEndIntent as EventListener);
            container.removeEventListener('touchcancel', handleTouchEndIntent as EventListener);
            container.removeEventListener('wheel', handleWheelIntent as EventListener);
        };
    }, [handleScrollEvent, handleWheelIntent, scrollEngine, setFollowMode, updatePinnedState]);

    // Session switch - always start pinned at bottom
    React.useEffect(() => {
        if (!currentSessionId || currentSessionId === lastSessionIdRef.current) {
            return;
        }

        lastSessionIdRef.current = currentSessionId;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        flushViewportAnchor();
        pendingViewportAnchorRef.current = null;

        // Always start pinned at bottom on session switch
        setFollowMode(sessionIsWorking ? 'smooth' : 'none');
        updatePinnedState(true);
        setShowScrollButtonState(false);
    }, [currentSessionId, flushViewportAnchor, sessionIsWorking, setFollowMode, setShowScrollButtonState, updatePinnedState]);

    // Maintain pin-to-bottom when content changes
    React.useEffect(() => {
        if (!sessionIsWorking) {
            scrollEngine.cancelFollow();
            setFollowMode('none');
        }
    }, [scrollEngine, sessionIsWorking, setFollowMode]);

    React.useEffect(() => {
        if (isSyncing) {
            return;
        }
        if (shouldSkipLiveContentSync()) {
            return;
        }
        schedulePinnedStateAndIndicators();
    }, [isSyncing, schedulePinnedStateAndIndicators, sessionMessageCount, shouldSkipLiveContentSync]);

    // Use ResizeObserver to detect content changes and maintain pin
    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container || typeof ResizeObserver === 'undefined') return;

        let lastScrollHeight = container.scrollHeight;
        let lastClientHeight = container.clientHeight;

        const observer = new ResizeObserver(() => {
            const nextScrollHeight = container.scrollHeight;
            const nextClientHeight = container.clientHeight;
            const scrollHeightChanged = nextScrollHeight !== lastScrollHeight;
            const clientHeightChanged = nextClientHeight !== lastClientHeight;

            if (scrollHeightChanged && isPinnedRef.current && sessionIsWorking) {
                setFollowMode('smooth');
                scrollToBottomInternal({ followBottom: true });
                lastScrollHeight = nextScrollHeight;
                lastClientHeight = nextClientHeight;
                updateScrollButtonVisibility();
                return;
            }

            if (clientHeightChanged) {
                const previousDistanceFromBottom = Math.max(
                    0,
                    lastScrollHeight - lastScrollTopRef.current - lastClientHeight,
                );

                if (isPinnedRef.current) {
                    const targetScrollTop = Math.max(
                        0,
                        nextScrollHeight - nextClientHeight - previousDistanceFromBottom,
                    );

                    if (Math.abs(container.scrollTop - targetScrollTop) > 0.5) {
                        markAutoScroll(targetScrollTop);
                        container.scrollTop = targetScrollTop;
                        lastScrollTopRef.current = targetScrollTop;
                    }

                    lastScrollHeight = nextScrollHeight;
                    lastClientHeight = nextClientHeight;
                    updateScrollButtonVisibility();
                    return;
                }
            }

            lastScrollHeight = nextScrollHeight;
            lastClientHeight = nextClientHeight;

            if (clientHeightChanged && !scrollHeightChanged) {
                updateScrollButtonVisibility();
                return;
            }

            if (scrollHeightChanged && shouldSkipLiveContentSync()) {
                return;
            }

            schedulePinnedStateAndIndicators();
        });

        observer.observe(container);

        return () => {
            observer.disconnect();
        };
    }, [markAutoScroll, schedulePinnedStateAndIndicators, scrollToBottomInternal, sessionIsWorking, setFollowMode, shouldSkipLiveContentSync, updateScrollButtonVisibility]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            if (shouldSkipLiveContentSync()) {
                return;
            }
            schedulePinnedStateAndIndicators();
            return;
        }

        const rafId = window.requestAnimationFrame(() => {
            if (shouldSkipLiveContentSync()) {
                return;
            }
            schedulePinnedStateAndIndicators();
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [currentSessionId, schedulePinnedStateAndIndicators, sessionMessageCount, shouldSkipLiveContentSync]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const handleMessageContentChange = React.useCallback(() => {
        if (shouldSkipLiveContentSync()) {
            return;
        }
        schedulePinnedStateAndIndicators();
    }, [schedulePinnedStateAndIndicators, shouldSkipLiveContentSync]);

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const existing = animationHandlersRef.current.get(messageId);
        if (existing) {
            return existing;
        }

        const handlers: AnimationHandlers = {
            onChunk: () => {
                if (shouldSkipLiveContentSync()) {
                    return;
                }
                schedulePinnedStateAndIndicators();
            },
            onComplete: () => {
                schedulePinnedStateAndIndicators();
            },
            onStreamingCandidate: () => {},
            onAnimationStart: () => {},
            onAnimatedHeightChange: () => {
                if (shouldSkipLiveContentSync()) {
                    return;
                }
                schedulePinnedStateAndIndicators();
            },
            onReservationCancelled: () => {},
            onReasoningBlock: () => {},
        };

        animationHandlersRef.current.set(messageId, handlers);
        return handlers;
    }, [schedulePinnedStateAndIndicators, shouldSkipLiveContentSync]);

    React.useEffect(() => {
        return () => {
            if (pinnedSyncRafRef.current !== null && typeof window !== 'undefined') {
                window.cancelAnimationFrame(pinnedSyncRafRef.current);
                pinnedSyncRafRef.current = null;
            }

            flushViewportAnchor();
            if (viewportAnchorTimerRef.current !== null) {
                clearTimeout(viewportAnchorTimerRef.current);
                viewportAnchorTimerRef.current = null;
            }
        };
    }, [flushViewportAnchor]);

    React.useEffect(() => {
        if (!onActiveTurnChange) {
            return;
        }

        const container = scrollRef.current;
        if (!container) {
            return;
        }

        let lastActiveTurnId: string | null = null;

        const spy = createScrollSpy({
            onActive: (turnId) => {
                if (turnId === lastActiveTurnId) {
                    return;
                }
                lastActiveTurnId = turnId;
                onActiveTurnChange(turnId);
            },
        });

        spy.setContainer(container);

        const elementByTurnId = new Map<string, HTMLElement>();

        const registerTurnNode = (node: HTMLElement): boolean => {
            const turnId = node.dataset.turnId;
            if (!turnId) {
                return false;
            }
            elementByTurnId.set(turnId, node);
            spy.register(node, turnId);
            return true;
        };

        const unregisterTurnNode = (node: HTMLElement): boolean => {
            const turnId = node.dataset.turnId;
            if (!turnId) {
                return false;
            }
            if (elementByTurnId.get(turnId) !== node) {
                return false;
            }
            elementByTurnId.delete(turnId);
            spy.unregister(turnId);
            return true;
        };

        const collectTurnNodes = (node: Node): HTMLElement[] => {
            if (!(node instanceof HTMLElement)) {
                return [];
            }
            const collected: HTMLElement[] = [];
            if (node.matches('[data-turn-id]')) {
                collected.push(node);
            }
            node.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((turnNode) => {
                collected.push(turnNode);
            });
            return collected;
        };

        container.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((node) => {
            registerTurnNode(node);
        });
        spy.markDirty();

        const mutationObserver = new MutationObserver((records) => {
            let changed = false;

            records.forEach((record) => {
                record.removedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (unregisterTurnNode(turnNode)) {
                            changed = true;
                        }
                    });
                });

                record.addedNodes.forEach((node) => {
                    collectTurnNodes(node).forEach((turnNode) => {
                        if (registerTurnNode(turnNode)) {
                            changed = true;
                        }
                    });
                });
            });

            if (changed) {
                spy.markDirty();
            }
        });
        mutationObserver.observe(container, { subtree: true, childList: true });

        const handleScroll = () => {
            spy.onScroll();
        };
        container.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScroll);
            mutationObserver.disconnect();
            spy.destroy();
        };
    }, [currentSessionId, onActiveTurnChange, scrollRef, sessionMessageCount]);

    return {
        scrollRef,
        handleMessageContentChange,
        getAnimationHandlers,
        showScrollButton,
        prepareForBottomResume,
        scrollToBottom,
        scrollToPosition,
        releasePinnedScroll,
        isPinned,
        isOverflowing,
        isProgrammaticFollowActive: scrollEngine.isFollowingBottom,
    };
};
