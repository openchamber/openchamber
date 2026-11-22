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
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

type ViewportAnchor = { messageId: string; offsetTop: number };
type TimelineIdentityToken = { key: string | null; connected: boolean };

type PendingScrollRequest = {
    identity: TimelineIdentityToken;
    kind: 'turn' | 'message';
    id: string;
    behavior: ScrollBehavior;
    turnId: string | null;
    resolve: (value: boolean) => void;
};

interface UseChatTimelineControllerOptions {
    sessionId: string | null;
    sessionKey: string | null;
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
    loadHistoryUntilMessage: (messageId: string, options: { maxBatches: number }) => Promise<boolean>;
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

const HISTORY_SCROLL_THRESHOLD_MIN_PX = 1200
const HISTORY_SCROLL_VIEWPORT_FACTOR = 1.5
const resolveHistoryScrollThreshold = (clientHeight: number): number => Math.max(
    HISTORY_SCROLL_THRESHOLD_MIN_PX,
    clientHeight * HISTORY_SCROLL_VIEWPORT_FACTOR,
)
const HISTORY_RENDER_WAIT_TIMEOUT_MS = 250
const HISTORY_LOAD_WAIT_LIMIT = 40
const HISTORY_INTERACTION_GUARD_MS = 2000
const SCROLL_PIN_TIMEOUT_MS = 2500
const turnModelCache = new WeakMap<ChatMessageEntry[], TurnWindowModel>()

export const isOlderHistoryPrependCommit = (input: {
    previousOldestId: string | null;
    previousNewestId: string | null;
    currentOldestId: string | null;
    currentNewestId: string | null;
}): boolean => Boolean(
    input.previousOldestId
    && input.currentOldestId
    && input.currentOldestId !== input.previousOldestId
    && input.previousNewestId
    && input.currentNewestId
    && input.currentNewestId === input.previousNewestId,
);

// external: https://bugs.webkit.org/show_bug.cgi?id=187449 iOS momentum scrolling can ignore scrollTop writes during prepend compensation.
const MOMENTUM_WATCHDOG_FRAMES = 20;
const MOMENTUM_WATCHDOG_TOLERANCE_PX = 4;

const setScrollTopDefeatingMomentum = (container: HTMLElement, target: number) => {
    const previousOverflow = container.style.overflow;
    container.style.overflow = 'hidden';
    container.scrollTop = target;
    void container.scrollHeight;
    container.style.overflow = previousOverflow;
    container.scrollTop = target;

    if (typeof window === 'undefined') return () => {};
    let cancelled = false;
    let frame: number;
    let frames = 0;
    const cancel = () => {
        cancelled = true;
        window.cancelAnimationFrame(frame);
        container.removeEventListener('touchstart', cancel);
    };
    container.addEventListener('touchstart', cancel, { passive: true, once: true });
    const watch = () => {
        if (cancelled) return;
        if (container.scrollTop < target - MOMENTUM_WATCHDOG_TOLERANCE_PX) {
            container.scrollTop = target;
        }
        frames += 1;
        if (frames < MOMENTUM_WATCHDOG_FRAMES) {
            frame = window.requestAnimationFrame(watch);
        } else {
            cancel();
        }
    };
    frame = window.requestAnimationFrame(watch);
    return cancel;
};

const hasInsertedBeforeKnownOldest = (
    previousOldestId: string | null,
    currentOldestId: string | null,
    messages: ChatMessageEntry[],
): boolean => {
    if (!previousOldestId || !currentOldestId || currentOldestId === previousOldestId) {
        return false;
    }

    return messages.some((message) => message.info.id === previousOldestId);
};

export const useChatTimelineController = ({
    sessionId,
    sessionKey,
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
    const previousTurnWindowKeyRef = React.useRef<string | null>(null);
    const turnWindowModel = React.useMemo(() => {
        if (previousTurnWindowKeyRef.current !== sessionKey) {
            previousTurnWindowKeyRef.current = sessionKey;
            previousTurnWindowModelRef.current = null;
            previousMessagesRef.current = null;
        }
        const cached = turnModelCache.get(messages)
        if (cached) {
            previousTurnWindowModelRef.current = cached
            previousMessagesRef.current = messages
            return cached
        }

        const incrementalModel = updateTurnWindowModelIncremental(
            previousTurnWindowModelRef.current,
            previousMessagesRef.current,
            messages,
        );
        const nextModel = incrementalModel ?? buildTurnWindowModel(messages);
        previousTurnWindowModelRef.current = nextModel;
        previousMessagesRef.current = messages;

        if (messages.length > 0) turnModelCache.set(messages, nextModel)

        return nextModel;
    }, [messages, sessionKey]);

    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [pendingRevealWork, setPendingRevealWork] = React.useState(false);
    const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);

    const turnModelRef = React.useRef(turnWindowModel);
    const isPinnedRef = React.useRef(isPinned);
    const isLoadingOlderRef = React.useRef(isLoadingOlder);
    const pendingRevealWorkRef = React.useRef(pendingRevealWork);
    const sessionIdRef = React.useRef<string | null>(sessionId);
    const timelineIdentityRef = React.useRef<TimelineIdentityToken>({ key: sessionKey, connected: true });
    if (timelineIdentityRef.current.key !== sessionKey) {
        timelineIdentityRef.current = { key: sessionKey, connected: true };
    }
    const messagesRef = React.useRef(messages);
    const initializedSessionKeyRef = React.useRef<string | null>(null);
    const pendingRenderResolversRef = React.useRef<Array<() => void>>([]);
    const pendingScrollRequestRef = React.useRef<PendingScrollRequest | null>(null);
    const scrollPinRef = React.useRef<{ turnId: string; expiresAt: number } | null>(null);
    const historyInteractionRef = React.useRef(false);
    const historyInteractionTimerRef = React.useRef<number | null>(null);
    const lastHistoryScrollTopRef = React.useRef<number | null>(null);
    const cancelMomentumWatchRef = React.useRef<(() => void) | null>(null);

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
        if (initializedSessionKeyRef.current === sessionKey) {
            return;
        }
        if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(historyInteractionTimerRef.current);
            historyInteractionTimerRef.current = null;
        }
        historyInteractionRef.current = false;
        lastHistoryScrollTopRef.current = null;
        initializedSessionKeyRef.current = sessionKey;
        const pendingScroll = pendingScrollRequestRef.current;
        if (pendingScroll && pendingScroll.identity !== timelineIdentityRef.current) {
            pendingScrollRequestRef.current = null;
            pendingScroll.resolve(false);
        }
        setIsLoadingOlder(false);
        isLoadingOlderRef.current = false;
        setPendingRevealWork(false);
        scrollPinRef.current = null;
        setActiveTurnId(null);
    }, [sessionKey]);

    React.useLayoutEffect(() => {
        if (!isPinned) {
            return;
        }
        const latestTurnId = turnWindowModel.turnIds[turnWindowModel.turnIds.length - 1];
        if (!latestTurnId) {
            return;
        }
        setActiveTurnId((current) => current === latestTurnId ? current : latestTurnId);
    }, [isPinned, turnWindowModel.turnIds]);

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

        if (pending.identity !== timelineIdentityRef.current) {
            resolvePendingScrollRequest(false);
            return;
        }

        const didScroll = pending.kind === 'turn'
            ? (messageListRef.current?.scrollToTurnId(pending.id, { behavior: pending.behavior }) ?? false)
            : (messageListRef.current?.scrollToMessageId(pending.id, { behavior: pending.behavior }) ?? false);

        if (didScroll) {
            if (pending.turnId) {
                scrollPinRef.current = {
                    turnId: pending.turnId,
                    expiresAt: Date.now() + SCROLL_PIN_TIMEOUT_MS,
                };
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

    React.useLayoutEffect(() => {
        if (!timelineIdentityRef.current.connected) {
            timelineIdentityRef.current = { key: sessionKey, connected: true };
        }
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
        setPendingRevealWork(false);
        return () => {
            timelineIdentityRef.current = { key: sessionKey, connected: false };
            cancelMomentumWatchRef.current?.();
            cancelMomentumWatchRef.current = null;
            historyInteractionRef.current = false;
            lastHistoryScrollTopRef.current = null;
            scrollPinRef.current = null;
            prePrependScrollRef.current = null;
            if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
                window.clearTimeout(historyInteractionTimerRef.current);
                historyInteractionTimerRef.current = null;
            }
            resolvePendingRenderWaiters();
            resolvePendingScrollRequest(false);
        };
    }, [resolvePendingRenderWaiters, resolvePendingScrollRequest, sessionKey]);

    const renderedMessages = messages;

    React.useLayoutEffect(() => {
        resolvePendingRenderWaiters();
        attemptPendingScrollRequest();
    }, [attemptPendingScrollRequest, renderedMessages, resolvePendingRenderWaiters]);

    const prePrependScrollRef = React.useRef<{
        identity: TimelineIdentityToken;
        height: number;
        top: number;
        anchor: ViewportAnchor | null;
        historyVirtualized: boolean;
        oldestId: string | null;
        newestId: string | null;
    } | null>(null);

    const captureViewportAnchor = React.useCallback((): ViewportAnchor | null => {
        return messageListRef.current?.captureViewportAnchor() ?? null;
    }, [messageListRef]);

    const restoreViewportAnchor = React.useCallback((anchor: ViewportAnchor): boolean => {
        return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
    }, [messageListRef]);

    const prependTrackingRef = React.useRef<{
        oldestId: string | null;
        newestId: string | null;
        scrollHeight: number;
    } | null>(null);

    React.useLayoutEffect(() => {
        prePrependScrollRef.current = null;
        prependTrackingRef.current = null;
    }, [sessionKey]);

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        let snap = prePrependScrollRef.current;
        const prev = prependTrackingRef.current;
        const currentOldestId = renderedMessages[0]?.info?.id ?? null;
        const currentNewestId = renderedMessages[renderedMessages.length - 1]?.info?.id ?? null;
        const isPrepend = prev
            ? isOlderHistoryPrependCommit({
                previousOldestId: prev.oldestId,
                previousNewestId: prev.newestId,
                currentOldestId,
                currentNewestId,
            }) || hasInsertedBeforeKnownOldest(prev.oldestId, currentOldestId, renderedMessages)
            : false;

        if (snap && snap.identity !== timelineIdentityRef.current) {
            prePrependScrollRef.current = null;
            snap = null;
        }

        const isSnapshotPrepend = snap
            ? isOlderHistoryPrependCommit({
                previousOldestId: snap.oldestId,
                previousNewestId: snap.newestId,
                currentOldestId,
                currentNewestId,
            }) || hasInsertedBeforeKnownOldest(snap.oldestId, currentOldestId, renderedMessages)
            : false;
        const didPrepend = isPrepend || isSnapshotPrepend;
        const shouldConsumeSnapshot = Boolean(snap && (isPrepend || isSnapshotPrepend));

        const updateTracking = () => {
            prependTrackingRef.current = {
                oldestId: currentOldestId,
                newestId: currentNewestId,
                scrollHeight: container.scrollHeight,
            };
        };

        const refreshPendingSnapshot = () => {
            const pending = prePrependScrollRef.current;
            if (!pending) {
                return;
            }

            prePrependScrollRef.current = {
                ...pending,
                height: container.scrollHeight,
                top: container.scrollTop,
                anchor: captureViewportAnchor(),
                oldestId: currentOldestId,
                newestId: currentNewestId,
            };
        };

        if (isPinnedRef.current) {
            if (didPrepend) {
                prePrependScrollRef.current = null;
                goToBottom('instant');
            } else if (snap) {
                refreshPendingSnapshot();
            }
            updateTracking();
            return;
        }

        const historyVirtualized = messageListRef.current?.isHistoryVirtualized() ?? false;

        if (snap && shouldConsumeSnapshot) {
            prePrependScrollRef.current = null;
            if (historyVirtualized) {
                if (!snap.historyVirtualized && snap.anchor) {
                    restoreViewportAnchor(snap.anchor);
                }
                updateTracking();
                return;
            }

            const heightDelta = container.scrollHeight - snap.height;
            const applyHeightDelta = (): boolean => {
                if (heightDelta <= 0) {
                    return false;
                }
                container.scrollTop = snap.top + heightDelta;
                return true;
            };

            if (isMobileSurfaceRuntime() && heightDelta > 0) {
                cancelMomentumWatchRef.current?.();
                cancelMomentumWatchRef.current = setScrollTopDefeatingMomentum(container, snap.top + heightDelta);
                updateTracking();
                return;
            }

            if (!(snap.anchor && restoreViewportAnchor(snap.anchor))) {
                applyHeightDelta();
            }
        } else if (isPrepend && prev && !historyVirtualized) {
            const delta = container.scrollHeight - prev.scrollHeight;
            if (delta > 0) {
                const target = container.scrollTop + delta;
                if (isMobileSurfaceRuntime()) {
                    cancelMomentumWatchRef.current?.();
                    cancelMomentumWatchRef.current = setScrollTopDefeatingMomentum(container, target);
                } else {
                    container.scrollTop = target;
                }
            }
        } else if (snap) {
            refreshPendingSnapshot();
        }

        updateTracking();
    }, [captureViewportAnchor, messageListRef, renderedMessages, scrollRef, restoreViewportAnchor, goToBottom]);

    const revealBufferedTurns = React.useCallback(async (): Promise<boolean> => false, []);

    const fetchOlderHistory = React.useCallback(async (input: {
        preserveViewport: boolean;
    }): Promise<boolean> => {
        if (!sessionIdRef.current || !timelineIdentityRef.current.key || !timelineIdentityRef.current.connected || isLoadingOlderRef.current) {
            return false;
        }
        if (!historySignalsRef.current.hasMoreAboveTurns) {
            return false;
        }

        const targetSessionId = sessionIdRef.current;
        const targetIdentity = timelineIdentityRef.current;
        if (!targetSessionId || !targetIdentity.key) {
            return false;
        }
        const clearOwnedPrependSnapshot = () => {
            if (prePrependScrollRef.current?.identity === targetIdentity) {
                prePrependScrollRef.current = null;
            }
        };

        const container = scrollRef.current;
        const beforeMessages = messagesRef.current;
        const beforeOldestMessageId = beforeMessages[0]?.info?.id ?? null;

        if (input.preserveViewport && container) {
            prePrependScrollRef.current = {
                identity: targetIdentity,
                height: container.scrollHeight,
                top: container.scrollTop,
                anchor: captureViewportAnchor(),
                historyVirtualized: messageListRef.current?.isHistoryVirtualized() ?? false,
                oldestId: beforeOldestMessageId,
                newestId: beforeMessages[beforeMessages.length - 1]?.info?.id ?? null,
            };
        }

        beginHistoryInteraction();
        isLoadingOlderRef.current = true;
        setIsLoadingOlder(true);

        try {
            await loadMoreMessages(targetSessionId, 'up');
            if (timelineIdentityRef.current !== targetIdentity) {
                clearOwnedPrependSnapshot();
                return false;
            }
            await waitForNextRenderCommitOrTimeout();
            if (timelineIdentityRef.current !== targetIdentity) {
                clearOwnedPrependSnapshot();
                return false;
            }
            const grew = messagesRef.current.length > beforeMessages.length
                || messagesRef.current[0]?.info?.id !== beforeOldestMessageId;
            if (!grew) clearOwnedPrependSnapshot();
            return grew;
        } catch (error) {
            clearOwnedPrependSnapshot();
            throw error;
        } finally {
            if (timelineIdentityRef.current === targetIdentity) {
                isLoadingOlderRef.current = false;
                setIsLoadingOlder(false);
                settleHistoryInteraction();
            }
        }
    }, [beginHistoryInteraction, captureViewportAnchor, loadMoreMessages, messageListRef, scrollRef, settleHistoryInteraction, waitForNextRenderCommitOrTimeout]);

    const loadEarlier = React.useCallback(async (options?: { userInitiated?: boolean }) => {
        const targetIdentity = timelineIdentityRef.current;
        if (!targetIdentity.connected) return;
        beginHistoryInteraction();
        if (options?.userInitiated) {
            releaseAutoFollow();
        }

        try {
            void (await fetchOlderHistory({ preserveViewport: true }));
        } finally {
            if (timelineIdentityRef.current === targetIdentity) {
                settleHistoryInteraction();
            }
        }
    }, [beginHistoryInteraction, fetchOlderHistory, releaseAutoFollow, settleHistoryInteraction]);

    const loadHistoryUntilMessage = React.useCallback(async (
        messageId: string,
        options: { maxBatches: number },
    ): Promise<boolean> => {
        const targetIdentity = timelineIdentityRef.current;
        const isLoaded = () => messageListRef.current?.hasMessageRow(messageId)
            ?? messagesRef.current.some((message) => message.info.id === messageId);
        let batches = 0;
        let waits = 0;
        while (targetIdentity.connected && timelineIdentityRef.current === targetIdentity) {
            if (isLoaded()) return true;
            if (batches >= options.maxBatches || !historySignalsRef.current.hasMoreAboveTurns) return false;
            if (isLoadingOlderRef.current) {
                waits += 1;
                if (waits > HISTORY_LOAD_WAIT_LIMIT) return false;
                await waitForNextRenderCommitOrTimeout();
                continue;
            }
            batches += 1;
            const grew = await fetchOlderHistory({ preserveViewport: true }).catch(() => false);
            if (!grew) return timelineIdentityRef.current === targetIdentity && isLoaded();
        }
        return false;
    }, [fetchOlderHistory, messageListRef, waitForNextRenderCommitOrTimeout]);

    const handleHistoryScroll = React.useCallback(() => {
        if (isMobileSurfaceRuntime()) return;
        const container = scrollRef.current;
        if (!container) return;
        const previousTop = lastHistoryScrollTopRef.current;
        lastHistoryScrollTopRef.current = container.scrollTop;
        if (previousTop === null || container.scrollTop >= previousTop || historyInteractionRef.current) return;
        if (isPinnedRef.current) return;
        if (container.scrollTop >= resolveHistoryScrollThreshold(container.clientHeight)) return;
        if (!historySignalsRef.current.canLoadEarlier) return;
        if (isLoadingOlderRef.current || pendingRevealWorkRef.current) return;

        void loadEarlier({ userInitiated: true });
    }, [loadEarlier, scrollRef]);

    const autoFilledSessionKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (isMobileSurfaceRuntime()) return;
        if (!sessionKey || autoFilledSessionKeyRef.current === sessionKey) return;
        if (!historySignals.canLoadEarlier || isLoadingOlder || pendingRevealWork || !isPinned) return;
        const frame = window.requestAnimationFrame(() => {
            const container = scrollRef.current;
            if (!container || container.scrollHeight > container.clientHeight + 1) return;
            if (autoFilledSessionKeyRef.current === sessionKey) return;
            autoFilledSessionKeyRef.current = sessionKey;
            void loadEarlier();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [historySignals.canLoadEarlier, isLoadingOlder, isPinned, loadEarlier, pendingRevealWork, renderedMessages.length, scrollRef, sessionKey]);

    const scrollToTurn = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!turnId || !sessionIdRef.current || !timelineIdentityRef.current.key || !timelineIdentityRef.current.connected) {
            return false;
        }

        const targetIdentity = timelineIdentityRef.current;
        releaseAutoFollow();
        setPendingRevealWork(true);

        try {
            if (timelineIdentityRef.current !== targetIdentity) {
                return false;
            }

            const turnIndex = turnModelRef.current.turnIndexById.get(turnId);
            if (typeof turnIndex !== 'number') {
                return false;
            }

            const result = await new Promise<boolean>((resolve) => {
                pendingScrollRequestRef.current = {
                    identity: targetIdentity,
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
            if (timelineIdentityRef.current === targetIdentity) {
                setPendingRevealWork(false);
            }
        }
    }, [attemptPendingScrollRequest, releaseAutoFollow]);

    const scrollToMessage = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!messageId || !sessionIdRef.current || !timelineIdentityRef.current.key || !timelineIdentityRef.current.connected) {
            return false;
        }

        const targetIdentity = timelineIdentityRef.current;
        releaseAutoFollow();
        setPendingRevealWork(true);

        try {
            if (timelineIdentityRef.current !== targetIdentity) {
                return false;
            }

            const turnId = turnModelRef.current.messageToTurnId.get(messageId);
            const turnIndex = turnModelRef.current.messageToTurnIndex.get(messageId);

            if (typeof turnIndex !== 'number') {
                return false;
            }

            const result = await new Promise<boolean>((resolve) => {
                pendingScrollRequestRef.current = {
                    identity: targetIdentity,
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
            if (timelineIdentityRef.current === targetIdentity) {
                setPendingRevealWork(false);
            }
        }
    }, [attemptPendingScrollRequest, releaseAutoFollow]);

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
        const pin = scrollPinRef.current;
        if (pin) {
            if (turnId !== pin.turnId && Date.now() < pin.expiresAt) {
                return;
            }
            scrollPinRef.current = null;
        }
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
        loadHistoryUntilMessage,
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
