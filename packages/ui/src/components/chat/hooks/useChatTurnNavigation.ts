import React from 'react';

export type ChatHashTarget =
    | { kind: 'turn'; id: string }
    | { kind: 'message'; id: string };

export const parseChatHashTarget = (hashValue: string): ChatHashTarget | null => {
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

export const resolveTurnOffsetTarget = (
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

export interface ChatTurnNavigation {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior; updateHash?: boolean }) => Promise<boolean>;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior; updateHash?: boolean }) => Promise<boolean>;
    scrollByTurnOffset: (offset: number) => Promise<boolean>;
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

    React.useEffect(() => {
        turnIdsRef.current = turnIds;
    }, [turnIds]);

    React.useEffect(() => {
        activeTurnIdRef.current = activeTurnId;
    }, [activeTurnId]);

    const scrollToTurnId = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior; updateHash?: boolean },
    ): Promise<boolean> => {
        if (!turnId) {
            return false;
        }

        if (options?.updateHash !== false) {
            setHash(`turn-${turnId}`);
        }

        return scrollToTurn(turnId, { behavior: options?.behavior });
    }, [scrollToTurn]);

    const scrollToMessageId = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior; updateHash?: boolean },
    ): Promise<boolean> => {
        if (!messageId) {
            return false;
        }

        if (options?.updateHash !== false) {
            setHash(`message-${messageId}`);
        }

        return scrollToMessage(messageId, { behavior: options?.behavior });
    }, [scrollToMessage]);

    const scrollByTurnOffset = React.useCallback(async (offset: number): Promise<boolean> => {
        const target = resolveTurnOffsetTarget(turnIdsRef.current, activeTurnIdRef.current, offset);

        if (target.kind === 'noop') {
            return offset === 0;
        }

        if (target.kind === 'resume') {
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

        const applyHash = () => {
            const target = parseChatHashTarget(window.location.hash);
            if (!target) {
                return;
            }

            if (target.kind === 'turn') {
                void scrollToTurnId(target.id, { behavior: 'auto', updateHash: false });
                return;
            }

            void scrollToMessageId(target.id, { behavior: 'auto', updateHash: false });
        };

        applyHash();
        window.addEventListener('hashchange', applyHash);
        return () => {
            window.removeEventListener('hashchange', applyHash);
        };
    }, [sessionId, scrollToMessageId, scrollToTurnId, turnIds.length]);

    return {
        scrollToTurnId,
        scrollToMessageId,
        scrollByTurnOffset,
        resumeToLatest,
    };
};
