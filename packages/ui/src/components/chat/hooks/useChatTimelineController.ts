import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { MessageListHandle } from '../MessageList';
import { TURN_WINDOW_DEFAULTS } from '../lib/turns/constants';
import {
    buildTurnWindowModel,
    clampTurnStart,
    getInitialTurnStart,
    updateTurnWindowModelIncremental,
    windowMessagesByTurn,
    type TurnWindowModel,
} from '../lib/turns/windowTurns';
import type { TurnHistorySignals } from '../lib/turns/historySignals';
import { getMemoryLimits, type SessionHistoryMeta } from '@/stores/types/sessionTypes';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { cancelOverlayScrollbarScroll } from '@/components/ui/overlay-scrollbar-events';

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
    loadAllEarlierAndScrollToTop: (onLoadingComplete?: () => void) => Promise<boolean>;
    cancelLoadAllEarlierAndScrollToTop: () => void;
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
const LOAD_ALL_HISTORY_TIMEOUT_MS = 30000
const RESUME_TO_BOTTOM_SETTLE_TIMEOUT_MS = 1000
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

    const [turnStart, setTurnStart] = React.useState(() => getInitialTurnStart(turnWindowModel.turnCount));
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [pendingRevealWork, setPendingRevealWork] = React.useState(false);
    const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);

    const turnModelRef = React.useRef(turnWindowModel);
    const turnStartRef = React.useRef(turnStart);
    const isPinnedRef = React.useRef(isPinned);
    const isLoadingOlderRef = React.useRef(isLoadingOlder);
    const pendingRevealWorkRef = React.useRef(pendingRevealWork);
    const sessionIdRef = React.useRef<string | null>(sessionId);
    const messagesRef = React.useRef(messages);
    const historyMetaRef = React.useRef<SessionHistoryMeta | null>(historyMeta);
    const previousTurnCountRef = React.useRef(turnWindowModel.turnCount);
    const initializedSessionRef = React.useRef<string | null>(null);
    const pendingRenderResolversRef = React.useRef<Array<() => void>>([]);
    const pendingScrollRequestRef = React.useRef<PendingScrollRequest | null>(null);
    const historyInteractionRef = React.useRef(false);
    const historyInteractionTimerRef = React.useRef<number | null>(null);

    const historySignals = React.useMemo(() => {
        const defaultLimit = getMemoryLimits().HISTORICAL_MESSAGES;
        const hasBufferedTurns = turnStart > 0;
        const hasMoreAboveTurns = historyMeta
            ? !historyMeta.complete
            : messages.length >= defaultLimit;
        const historyLoading = Boolean(historyMeta?.loading);
        return {
            hasBufferedTurns,
            hasMoreAboveTurns,
            historyLoading,
            canLoadEarlier: hasBufferedTurns || hasMoreAboveTurns,
        };
    }, [historyMeta, messages.length, turnStart]);

    const historySignalsRef = React.useRef(historySignals);

    turnModelRef.current = turnWindowModel;
    turnStartRef.current = turnStart;
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
        setTurnStart(getInitialTurnStart(turnWindowModel.turnCount));
        setIsLoadingOlder(false);
        setPendingRevealWork(false);
        setActiveTurnId(null);
        previousTurnCountRef.current = turnWindowModel.turnCount;
    }, [sessionId, turnWindowModel.turnCount]);

    React.useLayoutEffect(() => {
        setTurnStart((current) => clampTurnStart(current, turnWindowModel.turnCount));
    }, [turnWindowModel.turnCount]);

    React.useLayoutEffect(() => {
        const previousTurnCount = previousTurnCountRef.current;
        const nextTurnCount = turnWindowModel.turnCount;
        if (previousTurnCount === nextTurnCount) {
            return;
        }

        setTurnStart((current) => {
            const previousInitial = getInitialTurnStart(previousTurnCount);
            const nextInitial = getInitialTurnStart(nextTurnCount);
            if (
                !historyInteractionRef.current
                && !isLoadingOlderRef.current
                && !pendingRevealWorkRef.current
                && isPinnedRef.current
                && current === previousInitial
            ) {
                return nextInitial;
            }
            return clampTurnStart(current, nextTurnCount);
        });

        previousTurnCountRef.current = nextTurnCount;
    }, [turnWindowModel.turnCount]);

    const resolvePendingRenderWaiters = React.useCallback(() => {
        const resolvers = pendingRenderResolversRef.current;
        if (resolvers.length === 0) {
            return;
        }
        pendingRenderResolversRef.current = [];
        resolvers.forEach((resolve) => resolve());
    }, []);

    const waitForNextRenderCommit = React.useCallback((): Promise<void> => {
        return new Promise<void>((resolve) => {
            pendingRenderResolversRef.current.push(resolve);
        });
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

        if (typeof targetIndex === 'number' && targetIndex >= turnStartRef.current) {
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

    const renderedMessages = React.useMemo(() => {
        return windowMessagesByTurn(messages, turnWindowModel, turnStart);
    }, [messages, turnStart, turnWindowModel]);

    React.useLayoutEffect(() => {
        resolvePendingRenderWaiters();
        attemptPendingScrollRequest();
    }, [attemptPendingScrollRequest, renderedMessages, resolvePendingRenderWaiters, turnStart]);

    // --- Synchronous scroll compensation for load-more / reveal ---
    // fetchOlderHistory and revealBufferedTurns store a snapshot here
    // before triggering the state change. useLayoutEffect consumes it
    // after React commits new DOM — before the browser paints.
    const prePrependScrollRef = React.useRef<{
        height: number;
        top: number;
        anchor: ViewportAnchor | null;
    } | null>(null);
    const loadAllEarlierRunIdRef = React.useRef(0);

    const captureViewportAnchor = React.useCallback((): ViewportAnchor | null => {
        return messageListRef.current?.captureViewportAnchor() ?? null;
    }, [messageListRef]);

    const restoreViewportAnchor = React.useCallback((anchor: ViewportAnchor): boolean => {
        return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
    }, [messageListRef]);

    const snapshotPrependScroll = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            return;
        }
        prePrependScrollRef.current = {
            height: container.scrollHeight,
            top: container.scrollTop,
            anchor: captureViewportAnchor(),
        };
    }, [captureViewportAnchor, scrollRef]);

    React.useLayoutEffect(() => {
        const snap = prePrependScrollRef.current;
        const container = scrollRef.current;
        if (!snap || !container) return;
        prePrependScrollRef.current = null;

        // When a viewport anchor is available, delegate to MessageList
        // restoreViewportAnchor which falls back to virtualizer-aware
        // scrollHistoryIndexIntoView when the element is not in the DOM.
        if (snap.anchor && restoreViewportAnchor(snap.anchor)) {
            return;
        }

        // Fallback: height-delta compensation
        const delta = container.scrollHeight - snap.height;
        if (delta > 0) {
            container.scrollTop = snap.top + delta;
        }
    }, [renderedMessages, scrollRef, restoreViewportAnchor]);

    const revealBufferedTurns = React.useCallback(async (): Promise<boolean> => {
        if (turnStartRef.current <= 0 || pendingRevealWorkRef.current) {
            return false;
        }

        beginHistoryInteraction();
        cancelOverlayScrollbarScroll(scrollRef.current);
        snapshotPrependScroll();

        setPendingRevealWork(true);
        setTurnStart((current) => {
            const next = current - TURN_WINDOW_DEFAULTS.batchTurns;
            return next > 0 ? next : 0;
        });

        try {
            await waitForNextRenderCommit();
            return true;
        } finally {
            setPendingRevealWork(false);
            settleHistoryInteraction();
        }
    }, [beginHistoryInteraction, scrollRef, settleHistoryInteraction, snapshotPrependScroll, waitForNextRenderCommit]);

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
            cancelOverlayScrollbarScroll(container);
            snapshotPrependScroll();
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
    }, [beginHistoryInteraction, loadMoreMessages, scrollRef, settleHistoryInteraction, snapshotPrependScroll, waitForNextRenderCommitOrTimeout]);

    const loadEarlier = React.useCallback(async (options?: { userInitiated?: boolean }) => {
        beginHistoryInteraction();
        if (options?.userInitiated) {
            releaseAutoFollow();
        }

        try {
            if (await revealBufferedTurns()) {
                return;
            }

            void (await fetchOlderHistory({ preserveViewport: true }));
        } finally {
            settleHistoryInteraction();
        }
    }, [beginHistoryInteraction, fetchOlderHistory, releaseAutoFollow, revealBufferedTurns, settleHistoryInteraction]);

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
        cancelOverlayScrollbarScroll(scrollRef.current);
        setPendingRevealWork(true);

        try {
            if (sessionIdRef.current !== sessionId) {
                return false;
            }

            const turnIndex = turnModelRef.current.turnIndexById.get(turnId);
            if (typeof turnIndex !== 'number') {
                return false;
            }

            if (turnIndex < turnStartRef.current) {
                setTurnStart(turnIndex);
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
    }, [attemptPendingScrollRequest, releaseAutoFollow, scrollRef, sessionId]);

    const scrollToMessage = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!messageId || !sessionIdRef.current) {
            return false;
        }

        releaseAutoFollow();
        cancelOverlayScrollbarScroll(scrollRef.current);
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

            if (turnIndex < turnStartRef.current) {
                setTurnStart(turnIndex);
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
    }, [attemptPendingScrollRequest, releaseAutoFollow, scrollRef, sessionId]);

    const loadAllEarlierAndScrollToTop = React.useCallback(async (onLoadingComplete?: () => void): Promise<boolean> => {
        if (!sessionIdRef.current) {
            return false;
        }

        const runId = loadAllEarlierRunIdRef.current + 1;
        loadAllEarlierRunIdRef.current = runId;
        const isCancelled = () => loadAllEarlierRunIdRef.current !== runId;

        releaseAutoFollow();
        cancelOverlayScrollbarScroll(scrollRef.current);

        let madeProgress = false;

        // 1. Reveal any locally buffered turns first
        if (turnStartRef.current > 0) {
            snapshotPrependScroll();
            setTurnStart(0);
            await waitForNextRenderCommitOrTimeout();
            if (isCancelled()) {
                return madeProgress;
            }
            madeProgress = true;
        }

        // 2. Wait for any existing in-flight load operation to finish
        let waitAttempts = 30;
        while (historySignalsRef.current.historyLoading && waitAttempts > 0) {
            waitAttempts -= 1;
            await waitForNextRenderCommitOrTimeout();
            if (isCancelled()) {
                return madeProgress;
            }
        }

        // 3. Repeatedly fetch older history from server until there is absolutely no more
        let remainingAttempts = 100;
        let consecutiveNoGrowth = 0;
        const deadline = Date.now() + LOAD_ALL_HISTORY_TIMEOUT_MS;

        while (historySignalsRef.current.canLoadEarlier && remainingAttempts > 0) {
            if (isCancelled()) {
                return madeProgress;
            }
            if (Date.now() >= deadline) {
                break;
            }
            remainingAttempts -= 1;

            if (turnStartRef.current > 0) {
                snapshotPrependScroll();
                setTurnStart(0);
                await waitForNextRenderCommitOrTimeout();
                if (isCancelled()) {
                    return madeProgress;
                }
                madeProgress = true;
                continue;
            }

            if (!historySignalsRef.current.hasMoreAboveTurns) {
                break;
            }

            const beforeCount = messagesRef.current.length;

            const didLoad = await fetchOlderHistory({ preserveViewport: true });

            if (isCancelled()) {
                return madeProgress;
            }

            if (Date.now() >= deadline) {
                madeProgress = madeProgress || didLoad || messagesRef.current.length > beforeCount;
                break;
            }

            const afterCount = messagesRef.current.length;
            if (didLoad || afterCount > beforeCount) {
                madeProgress = true;
                consecutiveNoGrowth = 0;
            } else {
                consecutiveNoGrowth += 1;
                // If we get 3 consecutive no-growth results but hasMoreAboveTurns is still true,
                // wait a little bit extra to let any store updates settle, or break to avoid infinite loop.
                if (consecutiveNoGrowth >= 3) {
                    if (!historySignalsRef.current.hasMoreAboveTurns) {
                        break;
                    }
                    // Wait briefly for any lagging store updates, but stop if the overall load budget is spent.
                    await new Promise((resolve) => window.setTimeout(resolve, 500));
                    if (isCancelled()) {
                        return madeProgress;
                    }
                    if (Date.now() >= deadline) {
                        break;
                    }
                    await fetchOlderHistory({ preserveViewport: true });
                    if (isCancelled()) {
                        return madeProgress;
                    }
                    if (messagesRef.current.length <= afterCount) {
                        break; // Definitely done or failed
                    }
                }
            }
        }

        // Double check turnStart is 0
        if (turnStartRef.current > 0) {
            snapshotPrependScroll();
            setTurnStart(0);
            await waitForNextRenderCommitOrTimeout();
            if (isCancelled()) {
                return madeProgress;
            }
            madeProgress = true;
        }

        if (isCancelled()) {
            return madeProgress;
        }

        // Loading is fully complete, trigger callback before scroll animation starts
        onLoadingComplete?.();

        // 4. Scroll to the first user message or top
        const firstTurnId = turnModelRef.current.turnIds[0];
        if (firstTurnId) {
            return scrollToMessage(firstTurnId, { behavior: 'smooth' });
        }

        const container = scrollRef.current;
        if (container) {
            container.scrollTo({ top: 0, behavior: 'smooth' });
            return true;
        }

        return madeProgress;
    }, [fetchOlderHistory, releaseAutoFollow, scrollRef, scrollToMessage, snapshotPrependScroll, waitForNextRenderCommitOrTimeout]);

    const cancelLoadAllEarlierAndScrollToTop = React.useCallback(() => {
        loadAllEarlierRunIdRef.current += 1;
    }, []);

    const resumeToBottom = React.useCallback(async () => {
        const nextStart = getInitialTurnStart(turnModelRef.current.turnCount);
        setPendingRevealWork(false);
        setIsLoadingOlder(false);

        const shouldWaitForRender = nextStart !== turnStartRef.current;
        if (shouldWaitForRender) {
            const container = scrollRef.current;
            if (!container) {
                setTurnStart(nextStart);
                await waitForNextRenderCommit();
                goToBottom('smooth');
                return;
            }

            let finalized = false;
            const finalize = () => {
                if (finalized) {
                    return;
                }
                finalized = true;
                container.removeEventListener('scrollend', handleScrollEnd);
                if (settleTimeoutId !== null && typeof window !== 'undefined') {
                    window.clearTimeout(settleTimeoutId);
                }
                settleTimeoutId = null;

                if (sessionIdRef.current !== sessionId) {
                    return;
                }

                const distanceFromBottom = Math.max(container.scrollHeight - container.scrollTop - container.clientHeight, 0);
                if (distanceFromBottom > 1) {
                    return;
                }

                setTurnStart(nextStart);
                void waitForNextRenderCommit().then(() => {
                    if (sessionIdRef.current !== sessionId) {
                        return;
                    }
                    goToBottom('instant');
                });
            };

            const handleScrollEnd = () => {
                finalize();
            };

            let settleTimeoutId: number | null = null;
            if (typeof window !== 'undefined') {
                settleTimeoutId = window.setTimeout(() => {
                    settleTimeoutId = null;
                    finalize();
                }, RESUME_TO_BOTTOM_SETTLE_TIMEOUT_MS);
            }
            container.addEventListener('scrollend', handleScrollEnd);
            goToBottom('smooth');
            return;
        }

        goToBottom('smooth');
    }, [goToBottom, scrollRef, sessionId, waitForNextRenderCommit]);

    const resumeToBottomInstant = React.useCallback(async () => {
        const nextStart = getInitialTurnStart(turnModelRef.current.turnCount);
        setPendingRevealWork(false);
        setIsLoadingOlder(false);

        const shouldWaitForRender = nextStart !== turnStartRef.current;
        if (shouldWaitForRender) {
            setTurnStart(nextStart);
            await waitForNextRenderCommit();
        }

        goToBottom('instant');
    }, [goToBottom, waitForNextRenderCommit]);

    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        setActiveTurnId(turnId);
    }, []);

    return {
        turnIds: turnWindowModel.turnIds,
        turnStart,
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
        loadAllEarlierAndScrollToTop,
        cancelLoadAllEarlierAndScrollToTop,
        scrollToTurn,
        scrollToMessage,
        handleHistoryScroll,
        captureViewportAnchor,
        restoreViewportAnchor,
        handleActiveTurnChange,
    };
};
