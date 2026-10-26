import React from 'react';

type ChatHashTarget =
    | { kind: 'turn'; id: string }
    | { kind: 'message'; id: string };

const parseChatHashTarget = (hashValue: string): ChatHashTarget | null => {
    const value = hashValue.startsWith('#') ? hashValue.slice(1) : hashValue;
    if (!value) {
        return null;
    }

    const turnMatch = value.match(/^turn-(.+)$/);
    if (turnMatch?.[1]) {
        return { kind: 'turn', id: turnMatch[1] };
    }

    const messageMatch = value.match(/^message-(.+)$/);
    if (messageMatch?.[1]) {
        return { kind: 'message', id: messageMatch[1] };
    }

    return null;
};

type TurnOffsetTarget =
    | { kind: 'noop' }
    | { kind: 'resume' }
    | { kind: 'turn'; turnId: string };

const resolveTurnOffsetTarget = (
    turnIds: string[],
    activeTurnId: string | null,
    offset: number,
): TurnOffsetTarget => {
    if (offset === 0) {
        return { kind: 'noop' };
    }

    if (turnIds.length === 0) {
        return { kind: 'noop' };
    }

    const baseIndex = activeTurnId ? turnIds.indexOf(activeTurnId) : turnIds.length - 1;
    const normalizedBase = baseIndex >= 0 ? baseIndex : turnIds.length - 1;
    const targetIndex = normalizedBase + offset;

    if (targetIndex >= turnIds.length) {
        return { kind: 'resume' };
    }

    const clampedTarget = Math.max(0, targetIndex);
    const targetTurnId = turnIds[clampedTarget];
    if (!targetTurnId) {
        return { kind: 'noop' };
    }

    return { kind: 'turn', turnId: targetTurnId };
};

const setHash = (hash: string | null): void => {
    if (typeof window === 'undefined') {
        return;
    }

    const nextHash = hash ? `#${hash}` : '';
    const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
};

interface UseChatTurnNavigationOptions {
    sessionId: string | null;
    turnIds: string[];
    activeTurnId: string | null;
    scrollToTurn: (turnId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    resumeToBottom: () => void;
}

interface ChatTurnNavigation {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior; updateHash?: boolean }) => Promise<boolean>;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior; updateHash?: boolean }) => Promise<boolean>;
    scrollByTurnOffset: (offset: number, options?: { resumePastEnd?: boolean }) => Promise<boolean>;
    resumeToLatest: () => void;
}

export const useChatTurnNavigation = ({
    sessionId,
    turnIds,
    activeTurnId,
    scrollToTurn,
    scrollToMessage,
    resumeToBottom,
}: UseChatTurnNavigationOptions): ChatTurnNavigation => {
    const turnIdsRef = React.useRef(turnIds);
    const activeTurnIdRef = React.useRef(activeTurnId);
    // The hash this visit to the session has already scrolled to. The hash
    // effect re-runs whenever the turn count changes so a link resolves once
    // its turn loads; a target already reached must not be replayed when a
    // send adds a turn. Opening a session again applies its hash once more.
    const reachedHashRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        turnIdsRef.current = turnIds;
    }, [turnIds]);

    React.useEffect(() => {
        activeTurnIdRef.current = activeTurnId;
    }, [activeTurnId]);

    // Declared before the hash effect so the reset lands first in the same commit.
    React.useEffect(() => {
        reachedHashRef.current = null;
    }, [sessionId]);

    const writeReachedHash = React.useCallback((hash: string) => {
        setHash(hash);
        reachedHashRef.current = `#${hash}`;
    }, []);

    const scrollToTurnId = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior; updateHash?: boolean },
    ): Promise<boolean> => {
        if (!turnId) {
            return false;
        }

        if (options?.updateHash !== false) {
            writeReachedHash(`turn-${turnId}`);
        }

        return scrollToTurn(turnId, { behavior: options?.behavior });
    }, [scrollToTurn, writeReachedHash]);

    const scrollToMessageId = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior; updateHash?: boolean },
    ): Promise<boolean> => {
        if (!messageId) {
            return false;
        }

        if (options?.updateHash !== false) {
            writeReachedHash(`message-${messageId}`);
        }

        return scrollToMessage(messageId, { behavior: options?.behavior });
    }, [scrollToMessage, writeReachedHash]);

    const scrollByTurnOffset = React.useCallback(async (
        offset: number,
        options?: { resumePastEnd?: boolean },
    ): Promise<boolean> => {
        const turnIds = turnIdsRef.current;
        const target = resolveTurnOffsetTarget(turnIds, activeTurnIdRef.current, offset);

        if (target.kind === 'noop') {
            return offset === 0;
        }

        if (target.kind === 'resume') {
            if (options?.resumePastEnd === false) {
                const lastTurnId = turnIds[turnIds.length - 1];
                return lastTurnId ? scrollToTurnId(lastTurnId, { behavior: 'auto' }) : false;
            }

            setHash(null);
            resumeToBottom();
            return true;
        }

        return scrollToTurnId(target.turnId, { behavior: 'auto' });
    }, [resumeToBottom, scrollToTurnId]);

    const resumeToLatest = React.useCallback(() => {
        setHash(null);
        resumeToBottom();
    }, [resumeToBottom]);

    React.useEffect(() => {
        if (!sessionId || typeof window === 'undefined') {
            return;
        }

        const applyHash = (hashChanged: boolean) => {
            const hash = window.location.hash;
            const target = parseChatHashTarget(hash);
            if (!target) {
                return;
            }

            if (!hashChanged && reachedHashRef.current === hash) {
                return;
            }

            const scroll = target.kind === 'turn'
                ? scrollToTurnId(target.id, { behavior: 'auto', updateHash: false })
                : scrollToMessageId(target.id, { behavior: 'auto', updateHash: false });
            void scroll.then((arrived) => {
                if (arrived) {
                    reachedHashRef.current = hash;
                }
            });
        };
        const handleHashChange = () => applyHash(true);

        applyHash(false);
        window.addEventListener('hashchange', handleHashChange);
        return () => {
            window.removeEventListener('hashchange', handleHashChange);
        };
    }, [sessionId, scrollToMessageId, scrollToTurnId, turnIds.length]);

    return {
        scrollToTurnId,
        scrollToMessageId,
        scrollByTurnOffset,
        resumeToLatest,
    };
};
