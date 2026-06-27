import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { MessageListHandle } from '../MessageList';
import {
    buildTurnWindowModel,
    updateTurnWindowModelIncremental,
    type TurnWindowModel,
} from '../lib/turns/windowTurns';
import type { TurnHistorySignals } from '../lib/turns/historySignals';
import { getMemoryLimits, type SessionHistoryMeta } from '@/stores/types/sessionTypes';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

type ViewportAnchor = { messageId: string; offsetTop: number };

type PendingScrollRequest = {
    sessionId: string;
    kind: 'turn' | 'message';
    id: string;
    behavior: ScrollBehavior;
    turnId: string | null;
    resolve: (value: boolean) => void;
};

interface UseChatTimelineControllerOptions {
    sessionId: string | null;
    messages: ChatMessageEntry[];
    historyMeta: SessionHistoryMeta | null;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
    goToBottom: (mode?: 'instant' | 'smooth') => void;
    releaseAutoFollow: () => void;
    isPinned: boolean;
    showScrollButton: boolean;
}

export interface UseChatTimelineControllerResult {
    turnIds: string[];
    turnStart: number;
    renderedMessages: ChatMessageEntry[];
    historySignals: TurnHistorySignals;
    isLoadingOlder: boolean;
    pendingRevealWork: boolean;
    activeTurnId: string | null;
    showScrollToBottom: boolean;
    turnWindowModel: TurnWindowModel;
    loadEarlier: (options?: { userInitiated?: boolean }) => Promise<void>;
    revealBufferedTurns: () => Promise<boolean>;
    resumeToBottom: () => void;
    resumeToBottomInstant: () => Promise<void>;
    scrollToTurn: (turnId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    handleHistoryScroll: () => void;
    captureViewportAnchor: () => ViewportAnchor | null;
    restoreViewportAnchor: (anchor: ViewportAnchor) => boolean;
    handleActiveTurnChange: (turnId: string | null) => void;
}

const TURN_MODEL_CACHE_MAX = 30
const HISTORY_SCROLL_THRESHOLD = 200
const VSCODE_TURN_MODEL_CACHE_MAX = 4
const VSCODE_TURN_MODEL_CACHE_MAX_MESSAGES = 30
const MOBILE_TURN_MODEL_CACHE_MAX = 4
const MOBILE_TURN_MODEL_CACHE_MAX_MESSAGES = 30
const HISTORY_RENDER_WAIT_TIMEOUT_MS = 250
const HISTORY_INTERACTION_GUARD_MS = 2000
const turnModelCache = new Map<string, { messages: ChatMessageEntry[]; model: TurnWindowModel }>()
const getTurnModelCacheMax = () => {
    if (isVSCodeRuntime()) return VSCODE_TURN_MODEL_CACHE_MAX
    if (isMobileSurfaceRuntime()) return MOBILE_TURN_MODEL_CACHE_MAX
    return TURN_MODEL_CACHE_MAX
}

const shouldCacheTurnModelMessages = (messages: ChatMessageEntry[]): boolean => {
    if (isVSCodeRuntime()) return messages.length <= VSCODE_TURN_MODEL_CACHE_MAX_MESSAGES
    if (isMobileSurfaceRuntime()) return messages.length <= MOBILE_TURN_MODEL_CACHE_MAX_MESSAGES
    return true
}

const rememberTurnModel = (key: string, value: { messages: ChatMessageEntry[]; model: TurnWindowModel }) => {
    turnModelCache.delete(key)
    if (!shouldCacheTurnModelMessages(value.messages)) {
        return
    }
    const max = getTurnModelCacheMax()
    while (turnModelCache.size >= max) {
        const oldest = turnModelCache.keys().next().value
        if (typeof oldest !== 'string') break
        turnModelCache.delete(oldest)
    }
    turnModelCache.set(key, value)
}

export const shouldAutoLoadEarlierForUnderfilledPinnedViewport = (input: {
    sessionId: string | null;
    isPinned: boolean;
    canLoadEarlier: boolean;
    isLoadingOlder: boolean;
    pendingRevealWork: boolean;
    scrollHeight: number;
    clientHeight: number;
}): boolean => {
    if (!input.sessionId) return false;
    if (!input.isPinned || !input.canLoadEarlier) return false;
    if (input.isLoadingOlder || input.pendingRevealWork) return false;
    return input.scrollHeight <= input.clientHeight + 1;
};

export const useChatTimelineController = ({
    sessionId,
    messages,
    historyMeta,
    scrollRef,
    messageListRef,
    loadMoreMessages,
    goToBottom,
    releaseAutoFollow,
    isPinned,
    showScrollButton,
}: UseChatTimelineControllerOptions): UseChatTimelineControllerResult => {
    const previousTurnWindowModelRef = React.useRef<TurnWindowModel | null>(null);
    const previousMessagesRef = React.useRef<ChatMessageEntry[] | null>(null);
    const turnWindowModel = React.useMemo(() => {
        const key = sessionId ?? ""
        const cached = key ? turnModelCache.get(key) : undefined
        if (cached && cached.messages === messages) {
            rememberTurnModel(key, cached)
            previousTurnWindowModelRef.current = cached.model
            previousMessagesRef.current = messages
            return cached.model
        }

        const incrementalModel = updateTurnWindowModelIncremental(
            previousTurnWindowModelRef.current,
            previousMessagesRef.current,
            messages,
        );
        const nextModel = incrementalModel ?? buildTurnWindowModel(messages);
        previousTurnWindowModelRef.current = nextModel;
        previousMessagesRef.current = messages;

        if (key && messages.length > 0) {
            rememberTurnModel(key, { messages, model: nextModel })
        }

        return nextModel;
    }, [messages, sessionId]);

    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [pendingRevealWork, setPendingRevealWork] = React.useState(false);
    const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);

    const turnModelRef = React.useRef(turnWindowModel);
    const isPinnedRef = React.useRef(isPinned);
    const isLoadingOlderRef = React.useRef(isLoadingOlder);
    const pendingRevealWorkRef = React.useRef(pendingRevealWork);
    const sessionIdRef = React.useRef<string | null>(sessionId);
    const messagesRef = React.useRef(messages);
    const historyMetaRef = React.useRef<SessionHistoryMeta | null>(historyMeta);
    const initializedSessionRef = React.useRef<string | null>(null);
    const pendingRenderResolversRef = React.useRef<Array<() => void>>([]);
    const pendingScrollRequestRef = React.useRef<PendingScrollRequest | null>(null);
    const historyInteractionRef = React.useRef(false);
    const historyInteractionTimerRef = React.useRef<number | null>(null);

    const historySignals = React.useMemo(() => {
        const defaultLimit = getMemoryLimits().HISTORICAL_MESSAGES;
        const hasBufferedTurns = false;
        const hasMoreAboveTurns = historyMeta
            ? !historyMeta.complete
            : messages.length >= defaultLimit;
        const historyLoading = Boolean(historyMeta?.loading);
        return {
            hasBufferedTurns,
            hasMoreAboveTurns,
            historyLoading,
            canLoadEarlier: hasMoreAboveTurns,
        };
    }, [historyMeta, messages.length]);

    const historySignalsRef = React.useRef(historySignals);

    turnModelRef.current = turnWindowModel;
    isPinnedRef.current = isPinned;
    isLoadingOlderRef.current = isLoadingOlder;
    pendingRevealWorkRef.current = pendingRevealWork;
    historySignalsRef.current = historySignals;
    sessionIdRef.current = sessionId;
    messagesRef.current = messages;
    historyMetaRef.current = historyMeta;

    const beginHistoryInteraction = React.useCallback(() => {
        historyInteractionRef.current = true;
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
    }, []);

    const settleHistoryInteraction = React.useCallback(() => {
        if (typeof window === 'undefined') {
            historyInteractionRef.current = false;
            return;
        }

        if (historyInteractionTimerRef.current !== null) {
            window.clearTimeout(historyInteractionTimerRef.current);
        }
        historyInteractionTimerRef.current = window.setTimeout(() => {
            historyInteractionTimerRef.current = null;
            historyInteractionRef.current = false;
        }, HISTORY_INTERACTION_GUARD_MS);
    }, []);

    React.useLayoutEffect(() => {
        if (initializedSessionRef.current === sessionId) {
            return;
        }
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
        historyInteractionRef.current = false;
        initializedSessionRef.current = sessionId;
        setIsLoadingOlder(false);
        setPendingRevealWork(false);
        setActiveTurnId(null);
    }, [sessionId]);

    const resolvePendingRenderWaiters = React.useCallback(() => {
        const resolvers = pendingRenderResolversRef.current;
        if (resolvers.length === 0) {
            return;
        }
        pendingRenderResolversRef.current = [];
        resolvers.forEach((resolve) => resolve());
    }, []);

    const waitForNextRenderCommitOrTimeout = React.useCallback((): Promise<void> => {
        return new Promise<void>((resolve) => {
            if (typeof window === 'undefined') {
                resolve();
                return;
            }

            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve();
            };
            pendingRenderResolversRef.current.push(finish);
            const timer = window.setTimeout(finish, HISTORY_RENDER_WAIT_TIMEOUT_MS);
        });
    }, []);

    const resolvePendingScrollRequest = React.useCallback((value: boolean) => {
        const pending = pendingScrollRequestRef.current;
        if (!pending) {
            return;
        }
        pendingScrollRequestRef.current = null;
        pending.resolve(value);
    }, []);

    const attemptPendingScrollRequest = React.useCallback(() => {
        const pending = pendingScrollRequestRef.current;
        if (!pending) {
            return;
        }

        if (pending.sessionId !== sessionIdRef.current) {
            resolvePendingScrollRequest(false);
            return;
        }

        const didScroll = pending.kind === 'turn'
            ? (messageListRef.current?.scrollToTurnId(pending.id, { behavior: pending.behavior }) ?? false)
            : (messageListRef.current?.scrollToMessageId(pending.id, { behavior: pending.behavior }) ?? false);

        if (didScroll) {
            if (pending.turnId) {
                setActiveTurnId(pending.turnId);
            }
            resolvePendingScrollRequest(true);
            return;
        }

        const targetIndex = pending.kind === 'turn'
            ? turnModelRef.current.turnIndexById.get(pending.id)
            : turnModelRef.current.messageToTurnIndex.get(pending.id);

        if (typeof targetIndex === 'number') {
            resolvePendingScrollRequest(false);
        }
    }, [messageListRef, resolvePendingScrollRequest]);

    React.useEffect(() => {
        return () => {
            if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
                window.clearTimeout(historyInteractionTimerRef.current);
                historyInteractionTimerRef.current = null;
            }
            resolvePendingRenderWaiters();
            resolvePendingScrollRequest(false);
        };
    }, [resolvePendingRenderWaiters, resolvePendingScrollRequest]);

    const renderedMessages = messages;

    React.useLayoutEffect(() => {
        resolvePendingRenderWaiters();
        attemptPendingScrollRequest();
    }, [attemptPendingScrollRequest, renderedMessages, resolvePendingRenderWaiters]);

    // --- Synchronous scroll compensation for load-more / reveal ---
    // fetchOlderHistory and revealBufferedTurns store a snapshot here
    // before triggering the state change. useLayoutEffect consumes it
    // after React commits new DOM — before the browser paints.
    const prePrependScrollRef = React.useRef<{
        height: number;
        top: number;
        anchor: ViewportAnchor | null;
    } | null>(null);

    const captureViewportAnchor = React.useCallback((): ViewportAnchor | null => {
        return messageListRef.current?.captureViewportAnchor() ?? null;
    }, [messageListRef]);

    const restoreViewportAnchor = React.useCallback((anchor: ViewportAnchor): boolean => {
        return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
    }, [messageListRef]);

    // Tracks the timeline edges + height of the previous commit so a prepend
    // that did NOT go through fetchOlderHistory (e.g. the background history
    // prepend dispatched from useSync) can be compensated too. With
    // overflow-anchor:none the browser leaves scrollTop unchanged when content
    // is inserted above, so without this the viewport visibly jumps and
    // auto-follow yanks it back on the next frame — a one-shot up/down judder.
    const prependTrackingRef = React.useRef<{
        oldestId: string | null;
        newestId: string | null;
        scrollHeight: number;
    } | null>(null);

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const snap = prePrependScrollRef.current;
        const prev = prependTrackingRef.current;
        const currentOldestId = renderedMessages[0]?.info?.id ?? null;
        const currentNewestId = renderedMessages[renderedMessages.length - 1]?.info?.id ?? null;
        // A prepend = content inserted ABOVE the viewport: the oldest message id
        // changed while the newest stayed the same. This distinguishes a history
        // load from a bottom append, a streaming part growing, or a session switch.
        const isPrepend = Boolean(
            prev
            && prev.oldestId
            && currentOldestId
            && currentOldestId !== prev.oldestId
            && prev.newestId
            && currentNewestId
            && currentNewestId === prev.newestId,
        );

        const updateTracking = () => {
            prependTrackingRef.current = {
                oldestId: currentOldestId,
                newestId: currentNewestId,
                scrollHeight: container.scrollHeight,
            };
        };

        if (isPinnedRef.current) {
            // Bottom-pinned. Only content inserted ABOVE (a prepend / history load)
            // needs an explicit re-pin: with overflow-anchor:none the browser leaves
            // scrollTop unchanged, so the viewport would visibly jump. Route that
            // through goToBottom — the single programmatic writer.
            //
            // A normal bottom APPEND (a sent message, a streaming part) must NOT
            // re-pin here. Auto-follow's own follow loop — kicked by the content
            // ResizeObserver and the streaming chunk handlers — already eases to the
            // new bottom. Calling goToBottom on every append layered its settle burst
            // on top of that loop: two writers aiming at different positions, which
            // is exactly the up/down jiggle reported on send / from the queue / while
            // streaming. So for an append we do nothing and let the follow loop own it.
            if (snap || isPrepend) {
                prePrependScrollRef.current = null;
                goToBottom('instant');
            }
            updateTracking();
            return;
        }

        if (snap) {
            prePrependScrollRef.current = null;
            // When a viewport anchor is available, delegate to MessageList
            // restoreViewportAnchor which falls back to virtualizer-aware
            // scrollHistoryIndexIntoView when the element is not in the DOM.
            if (!(snap.anchor && restoreViewportAnchor(snap.anchor))) {
                // Fallback: height-delta compensation
                const delta = container.scrollHeight - snap.height;
                if (delta > 0) {
                    container.scrollTop = snap.top + delta;
                }
            }
        } else if (isPrepend && prev) {
            // Released viewport: preserve the read position by compensating for the
            // exact height the prepend added above, with no intermediate frame for
            // auto-follow to fight.
            const delta = container.scrollHeight - prev.scrollHeight;
            if (delta > 0) {
                container.scrollTop = container.scrollTop + delta;
            }
        }

        updateTracking();
    }, [renderedMessages, scrollRef, restoreViewportAnchor, goToBottom]);

    const revealBufferedTurns = React.useCallback(async (): Promise<boolean> => false, []);

    const fetchOlderHistory = React.useCallback(async (input: {
        preserveViewport: boolean;
    }): Promise<boolean> => {
        if (!sessionIdRef.current || isLoadingOlderRef.current) {
            return false;
        }
        if (!historySignalsRef.current.hasMoreAboveTurns) {
            return false;
        }

        const container = scrollRef.current;
        const beforeMessages = messagesRef.current;
        const beforeMessageCount = beforeMessages.length;
        const beforeOldestMessageId = beforeMessages[0]?.info?.id ?? null;
        const beforeLimit = historyMetaRef.current?.limit ?? getMemoryLimits().HISTORICAL_MESSAGES;

        // Store scroll snapshot BEFORE the fetch so useLayoutEffect can
        // compensate synchronously when React commits the new messages.
        if (input.preserveViewport && container) {
            prePrependScrollRef.current = {
                height: container.scrollHeight,
                top: container.scrollTop,
                anchor: captureViewportAnchor(),
            };
        }

        beginHistoryInteraction();
        setIsLoadingOlder(true);

        try {
            const targetSessionId = sessionIdRef.current;
            if (!targetSessionId) {
                return false;
            }

            let loadedMessageCount = beforeMessageCount;
            let loadedOldestMessageId = beforeOldestMessageId;
            let loadedLimit = beforeLimit;
            const beforeTurnCount = turnModelRef.current.turnCount;

            while (true) {
                await loadMoreMessages(targetSessionId, 'up');
                if (sessionIdRef.current !== targetSessionId) {
                    return false;
                }

                await waitForNextRenderCommitOrTimeout();

                const afterMessages = messagesRef.current;
                const afterMessageCount = afterMessages.length;
                const afterOldestMessageId = afterMessages[0]?.info?.id ?? null;
                const afterLimit = historyMetaRef.current?.limit ?? loadedLimit;
                const messageGrowth =
                    afterMessageCount > loadedMessageCount
                    || (typeof loadedOldestMessageId === 'string'
                        && typeof afterOldestMessageId === 'string'
                        && loadedOldestMessageId !== afterOldestMessageId)
                    || afterLimit > loadedLimit;
                const turnGrowth = turnModelRef.current.turnCount - beforeTurnCount;

                if (turnGrowth > 0) {
                    return true;
                }
                if (!messageGrowth) {
                    return false;
                }
                if (!historySignalsRef.current.hasMoreAboveTurns) {
                    return true;
                }

                loadedMessageCount = afterMessageCount;
                loadedOldestMessageId = afterOldestMessageId;
                loadedLimit = afterLimit;
            }
        } finally {
            setIsLoadingOlder(false);
            settleHistoryInteraction();
        }
    }, [beginHistoryInteraction, captureViewportAnchor, loadMoreMessages, scrollRef, settleHistoryInteraction, waitForNextRenderCommitOrTimeout]);

    const loadEarlier = React.useCallback(async (options?: { userInitiated?: boolean }) => {
        beginHistoryInteraction();
        if (options?.userInitiated) {
            releaseAutoFollow();
        }

        try {
            void (await fetchOlderHistory({ preserveViewport: true }));
        } finally {
            settleHistoryInteraction();
        }
    }, [beginHistoryInteraction, fetchOlderHistory, releaseAutoFollow, settleHistoryInteraction]);

    const handleHistoryScroll = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;
        if (isPinnedRef.current) return;
        if (container.scrollTop >= HISTORY_SCROLL_THRESHOLD) return;
        if (!historySignalsRef.current.canLoadEarlier) return;
        if (isLoadingOlderRef.current || pendingRevealWorkRef.current) return;

        void loadEarlier({ userInitiated: true });
    }, [loadEarlier, scrollRef]);

    const loadEarlierIfPinnedViewportUnderfilled = React.useCallback(() => {
        if (historyInteractionRef.current) return;
        const container = scrollRef.current;
        if (!container) return;
        if (!shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            sessionId: sessionIdRef.current,
            isPinned: isPinnedRef.current,
            canLoadEarlier: historySignalsRef.current.canLoadEarlier,
            isLoadingOlder: isLoadingOlderRef.current,
            pendingRevealWork: pendingRevealWorkRef.current,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        })) {
            return;
        }

        void loadEarlier();
    }, [loadEarlier, scrollRef]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const frame = window.requestAnimationFrame(() => {
            loadEarlierIfPinnedViewportUnderfilled();
        });

        return () => window.cancelAnimationFrame(frame);
    }, [
        historySignals.canLoadEarlier,
        isLoadingOlder,
        isPinned,
        loadEarlierIfPinnedViewportUnderfilled,
        pendingRevealWork,
        renderedMessages.length,
        sessionId,
    ]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
            return;
        }

        const container = scrollRef.current;
        if (!container) {
            return;
        }

        let frame: number | null = null;
        const scheduleCheck = () => {
            if (frame !== null) {
                return;
            }
            frame = window.requestAnimationFrame(() => {
                frame = null;
                loadEarlierIfPinnedViewportUnderfilled();
            });
        };

        const observer = new ResizeObserver(scheduleCheck);
        observer.observe(container);
        const content = container.firstElementChild;
        if (content instanceof Element) {
            observer.observe(content);
        }
        scheduleCheck();

        return () => {
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }
            observer.disconnect();
        };
    }, [loadEarlierIfPinnedViewportUnderfilled, scrollRef, sessionId]);

    const scrollToTurn = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!turnId || !sessionIdRef.current) {
            return false;
        }

        releaseAutoFollow();
        setPendingRevealWork(true);

        try {
            if (sessionIdRef.current !== sessionId) {
                return false;
            }

            const turnIndex = turnModelRef.current.turnIndexById.get(turnId);
            if (typeof turnIndex !== 'number') {
                return false;
            }

            const result = await new Promise<boolean>((resolve) => {
                pendingScrollRequestRef.current = {
                    sessionId: sessionIdRef.current ?? sessionId ?? '',
                    kind: 'turn',
                    id: turnId,
                    behavior: options?.behavior ?? 'auto',
                    turnId,
                    resolve,
                };
                attemptPendingScrollRequest();
            });

            if (result) {
                return true;
            }

            return false;
        } finally {
            setPendingRevealWork(false);
        }
    }, [attemptPendingScrollRequest, releaseAutoFollow, sessionId]);

    const scrollToMessage = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!messageId || !sessionIdRef.current) {
            return false;
        }

        releaseAutoFollow();
        setPendingRevealWork(true);

        try {
            if (sessionIdRef.current !== sessionId) {
                return false;
            }

            const turnId = turnModelRef.current.messageToTurnId.get(messageId);
            const turnIndex = turnModelRef.current.messageToTurnIndex.get(messageId);

            if (typeof turnIndex !== 'number') {
                return false;
            }

            const result = await new Promise<boolean>((resolve) => {
                pendingScrollRequestRef.current = {
                    sessionId: sessionIdRef.current ?? sessionId ?? '',
                    kind: 'message',
                    id: messageId,
                    behavior: options?.behavior ?? 'auto',
                    turnId: turnId ?? null,
                    resolve,
                };
                attemptPendingScrollRequest();
            });

            if (result) {
                return true;
            }

            return false;
        } finally {
            setPendingRevealWork(false);
        }
    }, [attemptPendingScrollRequest, releaseAutoFollow, sessionId]);

    const resumeToBottom = React.useCallback(async () => {
        setPendingRevealWork(false);
        setIsLoadingOlder(false);
        goToBottom('smooth');
    }, [goToBottom]);

    const resumeToBottomInstant = React.useCallback(async () => {
        setPendingRevealWork(false);
        setIsLoadingOlder(false);
        goToBottom('instant');
    }, [goToBottom]);

    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        setActiveTurnId(turnId);
    }, []);

    return {
        turnIds: turnWindowModel.turnIds,
        turnStart: 0,
        renderedMessages,
        historySignals,
        isLoadingOlder,
        pendingRevealWork,
        activeTurnId,
        showScrollToBottom: showScrollButton && !pendingRevealWork,
        turnWindowModel,
        loadEarlier,
        revealBufferedTurns,
        resumeToBottom,
        resumeToBottomInstant,
        scrollToTurn,
        scrollToMessage,
        handleHistoryScroll,
        captureViewportAnchor,
        restoreViewportAnchor,
        handleActiveTurnChange,
    };
};
