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
import { useViewportStore, type SessionMemoryState } from '@/sync/viewport-store';

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
    prepareForBottomResume: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollToBottom: (options?: { instant?: boolean; force?: boolean; followBottom?: boolean }) => void;
    isPinned: boolean;
    isOverflowing: boolean;
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
    loadEarlier: () => Promise<void>;
    revealBufferedTurns: () => Promise<boolean>;
    resumeToBottom: () => void;
    resumeToBottomInstant: () => void;
    restoreSavedScrollPosition: (savedPos: NonNullable<SessionMemoryState['scrollPosition']>) => Promise<void>;
    scrollToTurn: (turnId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    captureViewportAnchor: () => ViewportAnchor | null;
    restoreViewportAnchor: (anchor: ViewportAnchor) => boolean;
    handleActiveTurnChange: (turnId: string | null) => void;
}

export const useChatTimelineController = ({
    sessionId,
    messages,
    historyMeta,
    scrollRef,
    messageListRef,
    loadMoreMessages,
    prepareForBottomResume,
    scrollToBottom,
    isPinned,
    isOverflowing,
}: UseChatTimelineControllerOptions): UseChatTimelineControllerResult => {
    const previousTurnWindowModelRef = React.useRef<TurnWindowModel | null>(null);
    const previousMessagesRef = React.useRef<ChatMessageEntry[] | null>(null);
    const turnWindowModel = React.useMemo(() => {
        const incrementalModel = updateTurnWindowModelIncremental(
            previousTurnWindowModelRef.current,
            previousMessagesRef.current,
            messages,
        );
        const nextModel = incrementalModel ?? buildTurnWindowModel(messages);
        previousTurnWindowModelRef.current = nextModel;
        previousMessagesRef.current = messages;
        return nextModel;
    }, [messages]);

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

    React.useLayoutEffect(() => {
        if (initializedSessionRef.current === sessionId) {
            return;
        }
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
            if (isPinnedRef.current && current === previousInitial) {
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

    React.useLayoutEffect(() => {
        const snap = prePrependScrollRef.current;
        const container = scrollRef.current;
        if (!snap || !container) return;
        prePrependScrollRef.current = null;

        // Try anchor-based restoration first (pixel-perfect)
        if (snap.anchor) {
            const anchorEl = container.querySelector<HTMLElement>(
                `[data-message-id="${snap.anchor.messageId}"]`,
            );
            if (anchorEl) {
                const containerRect = container.getBoundingClientRect();
                const anchorTop = anchorEl.getBoundingClientRect().top - containerRect.top;
                container.scrollTop += anchorTop - snap.anchor.offsetTop;
                return;
            }
        }

        // Fallback: height-delta compensation
        const delta = container.scrollHeight - snap.height;
        if (delta > 0) {
            container.scrollTop = snap.top + delta;
        }
    }, [renderedMessages, scrollRef]);

    const captureViewportAnchor = React.useCallback((): ViewportAnchor | null => {
        return messageListRef.current?.captureViewportAnchor() ?? null;
    }, [messageListRef]);

    const restoreViewportAnchor = React.useCallback((anchor: ViewportAnchor): boolean => {
        return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
    }, [messageListRef]);

    const revealBufferedTurns = React.useCallback(async (): Promise<boolean> => {
        if (turnStartRef.current <= 0 || pendingRevealWorkRef.current) {
            return false;
        }

        const container = scrollRef.current;
        if (container) {
            prePrependScrollRef.current = {
                height: container.scrollHeight,
                top: container.scrollTop,
                anchor: captureViewportAnchor(),
            };
        }

        setPendingRevealWork(true);
        setTurnStart((current) => {
            const next = current - TURN_WINDOW_DEFAULTS.batchTurns;
            return next > 0 ? next : 0;
        });

        await waitForNextRenderCommit();
        setPendingRevealWork(false);
        return true;
    }, [captureViewportAnchor, scrollRef, waitForNextRenderCommit]);

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

        setIsLoadingOlder(true);

        try {
            const targetSessionId = sessionIdRef.current;
            if (!targetSessionId) {
                return false;
            }

            await loadMoreMessages(targetSessionId, 'up');

            const afterMessages = messagesRef.current;
            const afterMessageCount = afterMessages.length;
            const afterOldestMessageId = afterMessages[0]?.info?.id ?? null;
            const afterLimit = historyMetaRef.current?.limit ?? beforeLimit;
            const historyGrew =
                afterMessageCount > beforeMessageCount
                || (typeof beforeOldestMessageId === 'string'
                    && typeof afterOldestMessageId === 'string'
                    && beforeOldestMessageId !== afterOldestMessageId);

            return historyGrew || afterLimit > beforeLimit;
        } finally {
            setIsLoadingOlder(false);
        }
    }, [captureViewportAnchor, loadMoreMessages, scrollRef]);

    const loadEarlier = React.useCallback(async () => {
        if (await revealBufferedTurns()) {
            return;
        }

        void (await fetchOlderHistory({ preserveViewport: true }));
    }, [fetchOlderHistory, revealBufferedTurns]);

    const scrollToTurn = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!turnId || !sessionIdRef.current) {
            return false;
        }

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
    }, [attemptPendingScrollRequest, sessionId]);

    const scrollToMessage = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior },
    ): Promise<boolean> => {
        if (!messageId || !sessionIdRef.current) {
            return false;
        }

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
    }, [attemptPendingScrollRequest, sessionId]);

    const resumeToBottom = React.useCallback(async () => {
        const nextStart = getInitialTurnStart(turnModelRef.current.turnCount);
        setPendingRevealWork(false);
        setIsLoadingOlder(false);
        prepareForBottomResume({ force: true });

        const shouldWaitForRender = nextStart !== turnStartRef.current;
        if (shouldWaitForRender) {
            setTurnStart(nextStart);
            await waitForNextRenderCommit();
        }

        scrollToBottom({ force: true });
    }, [prepareForBottomResume, scrollToBottom, waitForNextRenderCommit]);

    const resumeToBottomInstant = React.useCallback(async () => {
        const nextStart = getInitialTurnStart(turnModelRef.current.turnCount);
        setPendingRevealWork(false);
        setIsLoadingOlder(false);
        prepareForBottomResume({ instant: true, force: true });

        const shouldWaitForRender = nextStart !== turnStartRef.current;
        if (shouldWaitForRender) {
            setTurnStart(nextStart);
            await waitForNextRenderCommit();
        }

        scrollToBottom({ instant: true, force: true, followBottom: true });
    }, [prepareForBottomResume, scrollToBottom, waitForNextRenderCommit]);

    // Restore scroll position from a saved pixel snapshot using ratio mapping.
    // Separate from resumeToBottomInstant to preserve "always go to bottom" semantics.
    const restoreSavedScrollPosition = React.useCallback(async (savedPos: NonNullable<SessionMemoryState['scrollPosition']>) => {
        const nextStart = getInitialTurnStart(turnModelRef.current.turnCount);
        setPendingRevealWork(false);
        setIsLoadingOlder(false);

        const shouldWaitForRender = nextStart !== turnStartRef.current;
        if (shouldWaitForRender) {
            setTurnStart(nextStart);
            await waitForNextRenderCommit();
        }

        const container = scrollRef.current;
        if (!container) return;

        const savedMaxScroll = Math.max(0, savedPos.scrollHeight - savedPos.clientHeight);
        if (savedMaxScroll <= 0) return;

        const ratio = savedPos.scrollTop / savedMaxScroll;
        const currentMaxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        const restoredTop = Math.round(ratio * currentMaxScroll);
        container.scrollTop = restoredTop;

        // Re-persist the restored position so intermediate scroll events
        // during the transition don't leave stale data for the next switch.
        const sid = sessionIdRef.current;
        if (sid) {
            const memState = useViewportStore.getState().sessionMemoryState.get(sid);
            if (memState) {
                useViewportStore.getState().updateViewportAnchor(sid, memState.viewportAnchor, {
                    scrollTop: restoredTop,
                    scrollHeight: container.scrollHeight,
                    clientHeight: container.clientHeight,
                });
            }
        }
    }, [scrollRef, waitForNextRenderCommit]);

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
        showScrollToBottom: isOverflowing && !isPinned && !pendingRevealWork,
        turnWindowModel,
        loadEarlier,
        revealBufferedTurns,
        resumeToBottom,
        resumeToBottomInstant,
        restoreSavedScrollPosition,
        scrollToTurn,
        scrollToMessage,
        captureViewportAnchor,
        restoreViewportAnchor,
        handleActiveTurnChange,
    };
};
