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

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

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
    messageStreamStates: Map<string, unknown>;
    trimToViewportWindow: (sessionId: string, targetSize?: number) => void;
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
    isPinned: boolean;
    isOverflowing: boolean;
}

const PROGRAMMATIC_SCROLL_SUPPRESS_MS = 200;
// Threshold for re-pinning: 10% of container height (matches bottom spacer)
const PIN_THRESHOLD_RATIO = 0.10;

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

    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [isPinned, setIsPinned] = React.useState(true);
    const [isOverflowing, setIsOverflowing] = React.useState(false);

    const lastSessionIdRef = React.useRef<string | null>(null);
    const suppressUserScrollUntilRef = React.useRef<number>(0);
    const isPinnedRef = React.useRef(true);
    const lastScrollTopRef = React.useRef<number>(0);

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

    const handleScrollEvent = React.useCallback((event?: Event) => {
        const container = scrollRef.current;
        if (!container || !currentSessionId) {
            return;
        }

        const now = Date.now();
        const isProgrammatic = now < suppressUserScrollUntilRef.current;

        scrollEngine.handleScroll();
        updateScrollButtonVisibility();

        // Handle pin/unpin logic
        const currentScrollTop = container.scrollTop;
        const distanceFromBottom = getDistanceFromBottom();

        // Unpin whenever trusted user scroll moves away from bottom.
        // This keeps drag-scroll/keyboard/trackpad behavior consistent.
        if (event?.isTrusted && !isProgrammatic && isPinnedRef.current) {
            if (!isNearBottom(distanceFromBottom, getPinThreshold())) {
                updatePinnedState(false);
            }
        }

        // Re-pin at bottom should always work (even momentum scroll)
        if (!isPinnedRef.current) {
            if (isNearBottom(distanceFromBottom, getPinThreshold())) {
                updatePinnedState(true);
            }
        }

        lastScrollTopRef.current = currentScrollTop;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const position = (scrollTop + clientHeight / 2) / Math.max(scrollHeight, 1);
        const estimatedIndex = Math.floor(position * sessionMessages.length);
        updateViewportAnchor(currentSessionId, estimatedIndex);
    }, [
        currentSessionId,
        getDistanceFromBottom,
        getPinThreshold,
        scrollEngine,
        sessionMessages.length,
        updatePinnedState,
        updateScrollButtonVisibility,
        updateViewportAnchor,
    ]);

    const handleWheelIntent = React.useCallback((event: WheelEvent) => {
        if (!isPinnedRef.current) {
            return;
        }

        const container = scrollRef.current;
        if (!container) {
            return;
        }

        const delta = normalizeWheelDelta({
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            rootHeight: container.clientHeight,
        });
        if (shouldPauseAutoScrollOnWheel({
            root: container,
            target: event.target,
            delta,
        })) {
            updatePinnedState(false);
        }
    }, [updatePinnedState]);

    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        container.addEventListener('scroll', handleScrollEvent as EventListener, { passive: true });
        container.addEventListener('wheel', handleWheelIntent as EventListener, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScrollEvent as EventListener);
            container.removeEventListener('wheel', handleWheelIntent as EventListener);
        };
    }, [handleScrollEvent, handleWheelIntent]);

    // Session switch - always start pinned at bottom
    useIsomorphicLayoutEffect(() => {
        if (!currentSessionId || currentSessionId === lastSessionIdRef.current) {
            return;
        }

        lastSessionIdRef.current = currentSessionId;
        MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);

        // Always start pinned at bottom on session switch
        updatePinnedState(true);
        setShowScrollButton(false);

        const container = scrollRef.current;
        if (container) {
            markProgrammaticScroll();
            scrollToBottomInternal({ instant: true });
        }
    }, [currentSessionId, markProgrammaticScroll, scrollToBottomInternal, updatePinnedState]);

    // Maintain pin-to-bottom when content changes
    React.useEffect(() => {
        if (!isPinnedRef.current) return;
        if (isSyncing) return;

        const container = scrollRef.current;
        if (!container) return;

        // When pinned and content grows, follow bottom with fast smooth scroll
        const distanceFromBottom = getDistanceFromBottom();
        if (distanceFromBottom > getPinThreshold()) {
            scrollPinnedToBottom();
        }
    }, [getDistanceFromBottom, getPinThreshold, isSyncing, scrollPinnedToBottom, sessionMessages]);

    // Use ResizeObserver to detect content changes and maintain pin
    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container || typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(() => {
            updateScrollButtonVisibility();

            // Maintain pin when content grows - fast smooth follow
            if (isPinnedRef.current) {
                const distanceFromBottom = getDistanceFromBottom();
                if (distanceFromBottom > getPinThreshold()) {
                    scrollPinnedToBottom();
                }
            }
        });

        observer.observe(container);

        // Also observe children for content changes
        const childObserver = new MutationObserver(() => {
            if (isPinnedRef.current) {
                const distanceFromBottom = getDistanceFromBottom();
                if (distanceFromBottom > getPinThreshold()) {
                    scrollPinnedToBottom();
                }
            }
        });

        childObserver.observe(container, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
            childObserver.disconnect();
        };
    }, [getDistanceFromBottom, getPinThreshold, scrollPinnedToBottom, updateScrollButtonVisibility]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            updateScrollButtonVisibility();
            return;
        }

        const rafId = window.requestAnimationFrame(() => {
            updateScrollButtonVisibility();
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [currentSessionId, sessionMessages.length, updateScrollButtonVisibility]);

    const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

    const handleMessageContentChange = React.useCallback(() => {
        updateScrollButtonVisibility();

        // Maintain pin when content changes - fast smooth follow
        if (isPinnedRef.current) {
            const distanceFromBottom = getDistanceFromBottom();
            if (distanceFromBottom > getPinThreshold()) {
                scrollPinnedToBottom();
            }
        }
    }, [getDistanceFromBottom, getPinThreshold, scrollPinnedToBottom, updateScrollButtonVisibility]);

    const getAnimationHandlers = React.useCallback((messageId: string): AnimationHandlers => {
        const existing = animationHandlersRef.current.get(messageId);
        if (existing) {
            return existing;
        }

        const handlers: AnimationHandlers = {
            onChunk: () => {
                updateScrollButtonVisibility();
                if (isPinnedRef.current) {
                    const distanceFromBottom = getDistanceFromBottom();
                    if (distanceFromBottom > getPinThreshold()) {
                        scrollPinnedToBottom();
                    }
                }
            },
            onComplete: () => {
                updateScrollButtonVisibility();
            },
            onStreamingCandidate: () => {},
            onAnimationStart: () => {},
            onAnimatedHeightChange: () => {
                updateScrollButtonVisibility();
                if (isPinnedRef.current) {
                    const distanceFromBottom = getDistanceFromBottom();
                    if (distanceFromBottom > getPinThreshold()) {
                        scrollPinnedToBottom();
                    }
                }
            },
            onReservationCancelled: () => {},
            onReasoningBlock: () => {},
        };

        animationHandlersRef.current.set(messageId, handlers);
        return handlers;
    }, [getDistanceFromBottom, getPinThreshold, scrollPinnedToBottom, updateScrollButtonVisibility]);

    React.useEffect(() => {
        if (!onActiveTurnChange) {
            return;
        }

        const container = scrollRef.current;
        if (!container) {
            onActiveTurnChange(null);
            return;
        }

        const spy = createScrollSpy({
            onActive: (turnId) => {
                onActiveTurnChange(turnId);
            },
        });

        spy.setContainer(container);

        const registerTurns = () => {
            spy.clear();
            const turnNodes = container.querySelectorAll<HTMLElement>('[data-turn-id]');
            turnNodes.forEach((node) => {
                const turnId = node.dataset.turnId;
                if (!turnId) {
                    return;
                }
                spy.register(node, turnId);
            });
            spy.markDirty();
        };

        registerTurns();

        const mutationObserver = new MutationObserver(() => {
            registerTurns();
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
            onActiveTurnChange(null);
        };
    }, [currentSessionId, onActiveTurnChange, scrollRef, sessionMessages.length]);

    return {
        scrollRef,
        handleMessageContentChange,
        getAnimationHandlers,
        showScrollButton,
        scrollToBottom,
        scrollToPosition,
        isPinned,
        isOverflowing,
    };
};
