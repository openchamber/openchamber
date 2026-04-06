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

const waitForFrames = async (count = 1): Promise<void> => {
    if (typeof window === 'undefined') {
        return;
    }
    for (let index = 0; index < count; index += 1) {
        await new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => resolve());
        });
    }
};

type ViewportAnchor = { messageId: string; offsetTop: number };

interface UseChatTimelineControllerOptions {
    sessionId: string | null;
    messages: ChatMessageEntry[];
    historyMeta: SessionHistoryMeta | null;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
    scrollToBottom: (options?: { instant?: boolean; force?: boolean }) => void;
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

    React.useEffect(() => {
        turnModelRef.current = turnWindowModel;
    }, [turnWindowModel]);

    React.useEffect(() => {
        turnStartRef.current = turnStart;
    }, [turnStart]);

    React.useEffect(() => {
        isPinnedRef.current = isPinned;
    }, [isPinned]);

    React.useEffect(() => {
        isLoadingOlderRef.current = isLoadingOlder;
    }, [isLoadingOlder]);

    React.useEffect(() => {
        pendingRevealWorkRef.current = pendingRevealWork;
    }, [pendingRevealWork]);

    React.useEffect(() => {
        historySignalsRef.current = historySignals;
    }, [historySignals]);

    React.useEffect(() => {
        sessionIdRef.current = sessionId;
    }, [sessionId]);

    React.useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    React.useEffect(() => {
        historyMetaRef.current = historyMeta;
    }, [historyMeta]);

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

    const renderedMessages = React.useMemo(() => {
        return windowMessagesByTurn(messages, turnWindowModel, turnStart);
    }, [messages, turnStart, turnWindowModel]);

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

        await waitForFrames(1);
        setPendingRevealWork(false);
        return true;
    }, [captureViewportAnchor, scrollRef]);

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
                await waitForFrames(2);
            }

            const didScroll = messageListRef.current?.scrollToTurnId(turnId, {
                behavior: options?.behavior,
            }) ?? false;

            if (didScroll) {
                setActiveTurnId(turnId);
                return true;
            }

            await waitForFrames(2);
            return messageListRef.current?.scrollToTurnId(turnId, {
                behavior: options?.behavior,
            }) ?? false;
        } finally {
            setPendingRevealWork(false);
        }
    }, [messageListRef, sessionId]);

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
                await waitForFrames(2);
            }

            const didScroll = messageListRef.current?.scrollToMessageId(messageId, {
                behavior: options?.behavior,
            }) ?? false;

            if (didScroll) {
                if (turnId) {
                    setActiveTurnId(turnId);
                }
                return true;
            }

            await waitForFrames(2);
            return messageListRef.current?.scrollToMessageId(messageId, {
                behavior: options?.behavior,
            }) ?? false;
        } finally {
            setPendingRevealWork(false);
        }
    }, [messageListRef, sessionId]);

    const resumeToBottom = React.useCallback(() => {
        const nextStart = getInitialTurnStart(turnModelRef.current.turnCount);
        setTurnStart(nextStart);
        setPendingRevealWork(false);
        setIsLoadingOlder(false);
        scrollToBottom({ force: true });
    }, [scrollToBottom]);

    const resumeToBottomInstant = React.useCallback(() => {
        const nextStart = getInitialTurnStart(turnModelRef.current.turnCount);
        setTurnStart(nextStart);
        setPendingRevealWork(false);
        setIsLoadingOlder(false);
        scrollToBottom({ instant: true, force: true });
    }, [scrollToBottom]);

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
        scrollToTurn,
        scrollToMessage,
        captureViewportAnchor,
        restoreViewportAnchor,
        handleActiveTurnChange,
    };
};
