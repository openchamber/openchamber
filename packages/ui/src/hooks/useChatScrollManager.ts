import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { createScrollSpy } from '@/components/chat/lib/scroll/scrollSpy';
import {
    isNearBottom,
    normalizeWheelDelta,
    shouldPauseAutoScrollOnWheel,
} from '@/components/chat/lib/scroll/scrollIntent';

import { useScrollEngine } from './useScrollEngine';

export type ContentChangeReason = 'text' | 'structural' | 'permission';

interface ChatMessageRecord {
    info: Record<string, unknown>;
    parts: Part[];
}

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
    sessionMessages: ChatMessageRecord[];
    sessionPermissions: unknown[];
    streamingMessageId: string | null;
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

interface UseChatScrollManagerResult {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    handleMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    showScrollButton: boolean;
    scrollToBottom: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollToPosition: (position: number, options?: { instant?: boolean }) => void;
    releasePinnedScroll: () => void;
    isPinned: boolean;
    isOverflowing: boolean;
    isProgrammaticFollowActive: boolean;
}

const PROGRAMMATIC_SCROLL_SUPPRESS_MS = 200;
const DIRECT_SCROLL_INTENT_WINDOW_MS = 250;
// Threshold for re-pinning: 10% of container height (matches bottom spacer)
const PIN_THRESHOLD_RATIO = 0.10;
const VIEWPORT_ANCHOR_MIN_UPDATE_MS = 150;

export const useChatScrollManager = ({
    currentSessionId,
    sessionMessages,
    streamingMessageId,
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

    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [isPinned, setIsPinned] = React.useState(true);
    const [isOverflowing, setIsOverflowing] = React.useState(false);

    const lastSessionIdRef = React.useRef<string | null>(null);
    const suppressUserScrollUntilRef = React.useRef<number>(0);
    const lastDirectScrollIntentAtRef = React.useRef<number>(0);
    const isPinnedRef = React.useRef(true);
    const lastScrollTopRef = React.useRef<number>(0);
    const touchLastYRef = React.useRef<number | null>(null);
    const pinnedSyncRafRef = React.useRef<number | null>(null);
    const preferInstantPinRef = React.useRef(false);
    const viewportAnchorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingViewportAnchorRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const lastViewportAnchorRef = React.useRef<{ sessionId: string; anchor: number } | null>(null);
    const lastViewportAnchorWriteAtRef = React.useRef<number>(0);

    const markProgrammaticScroll = React.useCallback(() => {
        suppressUserScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_SUPPRESS_MS;
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

    const scrollToBottomInternal = React.useCallback((options?: { instant?: boolean; followBottom?: boolean }) => {
        const container = scrollRef.current;
        if (!container) return;

        const bottom = container.scrollHeight - container.clientHeight;
        markProgrammaticScroll();
        scrollEngine.scrollToPosition(Math.max(0, bottom), options);
    }, [markProgrammaticScroll, scrollEngine]);

    const scrollPinnedToBottom = React.useCallback(() => {
        if (streamingMessageId) {
            scrollToBottomInternal({ followBottom: true });
            return;
        }

        scrollToBottomInternal({ instant: true });
    }, [scrollToBottomInternal, streamingMessageId]);

    const updateScrollButtonVisibility = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            setShowScrollButton(false);
            setIsOverflowing(false);
            return;
        }

        const hasScrollableContent = container.scrollHeight > container.clientHeight;
        setIsOverflowing(hasScrollableContent);
        if (!hasScrollableContent) {
            setShowScrollButton(false);
            return;
        }

        // Show scroll button when scrolled above the 10vh threshold
        const distanceFromBottom = getDistanceFromBottom();
        setShowScrollButton(!isNearBottom(distanceFromBottom, getPinThreshold()));
    }, [getDistanceFromBottom, getPinThreshold]);

    const syncPinnedStateAndIndicators = React.useCallback(() => {
        pinnedSyncRafRef.current = null;
        updateScrollButtonVisibility();
        if (!isPinnedRef.current) {
            return;
        }

        const distanceFromBottom = getDistanceFromBottom();
        if (distanceFromBottom <= getAutoFollowThreshold()) {
            preferInstantPinRef.current = false;
            return;
        }

        if (preferInstantPinRef.current) {
            scrollToBottomInternal({ instant: true });
            return;
        }

        if (distanceFromBottom > getAutoFollowThreshold()) {
            scrollPinnedToBottom();
        }
    }, [getAutoFollowThreshold, getDistanceFromBottom, scrollPinnedToBottom, scrollToBottomInternal, updateScrollButtonVisibility]);

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

        markProgrammaticScroll();
        scrollEngine.scrollToPosition(Math.max(0, position), options);
    }, [markProgrammaticScroll, scrollEngine]);

    const scrollToBottom = React.useCallback((options?: { instant?: boolean; force?: boolean }) => {
        const container = scrollRef.current;
        if (!container) return;

        // Re-pin when explicitly scrolling to bottom
        updatePinnedState(true);

        scrollToBottomInternal(options);
        setShowScrollButton(false);
    }, [scrollToBottomInternal, updatePinnedState]);

    const releasePinnedScroll = React.useCallback(() => {
        scrollEngine.cancelFollow();
        preferInstantPinRef.current = false;
        updatePinnedState(false);
        schedulePinnedStateAndIndicators();
    }, [schedulePinnedStateAndIndicators, scrollEngine, updatePinnedState]);

    const handleScrollEvent = React.useCallback((event?: Event) => {
        const container = scrollRef.current;
        if (!container || !currentSessionId) {
            return;
        }

        const now = Date.now();
        const isProgrammatic = now < suppressUserScrollUntilRef.current;
        const hasDirectIntent = now - lastDirectScrollIntentAtRef.current <= DIRECT_SCROLL_INTENT_WINDOW_MS;

        scrollEngine.handleScroll();
        schedulePinnedStateAndIndicators();

        // Handle pin/unpin logic
        const currentScrollTop = container.scrollTop;
        const scrollingUp = currentScrollTop < lastScrollTopRef.current;

        // Unpin requires strict user intent check
        if (event?.isTrusted && !isProgrammatic && hasDirectIntent) {
            if (scrollingUp && isPinnedRef.current) {
                updatePinnedState(false);
            }
        }

        // Re-pin at bottom should always work (even momentum scroll)
        if (!isPinnedRef.current) {
            const distanceFromBottom = getDistanceFromBottom();
            if (distanceFromBottom <= getPinThreshold()) {
                preferInstantPinRef.current = false;
                updatePinnedState(true);
            }
        }

        lastScrollTopRef.current = currentScrollTop;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const position = (scrollTop + clientHeight / 2) / Math.max(scrollHeight, 1);
        const estimatedIndex = Math.floor(position * sessionMessages.length);
        queueViewportAnchor(currentSessionId, estimatedIndex);
    }, [
        currentSessionId,
        getDistanceFromBottom,
        getPinThreshold,
        queueViewportAnchor,
        schedulePinnedStateAndIndicators,
        scrollEngine,
        sessionMessages.length,
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
            updatePinnedState(false);
        }
    }, [scrollEngine, updatePinnedState]);

    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const markDirectIntent = () => {
            lastDirectScrollIntentAtRef.current = Date.now();
        };

        const handleTouchStartIntent = (event: TouchEvent) => {
            markDirectIntent();
            const touch = event.touches.item(0);
            touchLastYRef.current = touch ? touch.clientY : null;
        };

        const handleTouchMoveIntent = (event: TouchEvent) => {
            markDirectIntent();

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
        container.addEventListener('wheel', markDirectIntent as EventListener, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScrollEvent as EventListener);
            container.removeEventListener('touchstart', handleTouchStartIntent as EventListener);
            container.removeEventListener('touchmove', handleTouchMoveIntent as EventListener);
            container.removeEventListener('touchend', handleTouchEndIntent as EventListener);
            container.removeEventListener('touchcancel', handleTouchEndIntent as EventListener);
            container.removeEventListener('wheel', handleWheelIntent as EventListener);
            container.removeEventListener('wheel', markDirectIntent as EventListener);
        };
    }, [handleScrollEvent, handleWheelIntent, scrollEngine, updatePinnedState]);

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
        preferInstantPinRef.current = true;
        updatePinnedState(true);
        setShowScrollButton(false);

        const container = scrollRef.current;
        if (container) {
            markProgrammaticScroll();
            scrollToBottomInternal({ instant: true });
        }
    }, [currentSessionId, flushViewportAnchor, markProgrammaticScroll, scrollToBottomInternal, updatePinnedState]);

    // Maintain pin-to-bottom when content changes
    React.useEffect(() => {
        if (isSyncing) {
            return;
        }
        schedulePinnedStateAndIndicators();
    }, [isSyncing, schedulePinnedStateAndIndicators, sessionMessages.length]);

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
                        markProgrammaticScroll();
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

            schedulePinnedStateAndIndicators();
        });

        observer.observe(container);

        // Also observe children for content changes
        const childObserver = new MutationObserver(() => {
            schedulePinnedStateAndIndicators();
        });

        childObserver.observe(container, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
            childObserver.disconnect();
        };
    }, [schedulePinnedStateAndIndicators, updateScrollButtonVisibility]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            schedulePinnedStateAndIndicators();
            return;
        }

        const rafId = window.requestAnimationFrame(() => {
            schedulePinnedStateAndIndicators();
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [currentSessionId, schedulePinnedStateAndIndicators, sessionMessages.length]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const handleMessageContentChange = React.useCallback(() => {
        schedulePinnedStateAndIndicators();
    }, [schedulePinnedStateAndIndicators]);

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const existing = animationHandlersRef.current.get(messageId);
        if (existing) {
            return existing;
        }

        const handlers: AnimationHandlers = {
            onChunk: () => {
                schedulePinnedStateAndIndicators();
            },
            onComplete: () => {
                schedulePinnedStateAndIndicators();
            },
            onStreamingCandidate: () => {},
            onAnimationStart: () => {},
            onAnimatedHeightChange: () => {
                schedulePinnedStateAndIndicators();
            },
            onReservationCancelled: () => {},
            onReasoningBlock: () => {},
        };

        animationHandlersRef.current.set(messageId, handlers);
        return handlers;
    }, [schedulePinnedStateAndIndicators]);

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
    }, [currentSessionId, onActiveTurnChange, scrollRef, sessionMessages.length]);

    return {
        scrollRef,
        handleMessageContentChange,
        getAnimationHandlers,
        showScrollButton,
        scrollToBottom,
        scrollToPosition,
        releasePinnedScroll,
        isPinned,
        isOverflowing,
        isProgrammaticFollowActive: scrollEngine.isFollowingBottom,
    };
};
