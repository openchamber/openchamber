import type { ChatMessageEntry } from './types';
import { TURN_WINDOW_DEFAULTS } from './constants';

const resolveMessageRole = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null; role?: string | null }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

const resolveParentMessageId = (message: ChatMessageEntry): string | undefined => {
    const parentId = (message.info as { parentID?: unknown }).parentID;
    if (typeof parentId !== 'string' || parentId.trim().length === 0) {
        return undefined;
    }
    return parentId;
};

export interface TurnWindowModel {
    turnIds: string[];
    turnMessageStartIndexes: number[];
    turnIndexById: Map<string, number>;
    messageToTurnId: Map<string, string>;
    messageToTurnIndex: Map<string, number>;
    turnCount: number;
}

export const buildTurnWindowModel = (messages: ChatMessageEntry[]): TurnWindowModel => {
    const turnIds: string[] = [];
    const turnMessageStartIndexes: number[] = [];
    const turnIndexById = new Map<string, number>();
    const messageToTurnId = new Map<string, string>();
    const messageToTurnIndex = new Map<string, number>();
    const userMessageToTurnIndex = new Map<string, number>();

    let currentTurnIndex = -1;

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        const messageId = message.info.id;

        if (role === 'user') {
            currentTurnIndex = turnIds.length;
            turnIds.push(messageId);
            turnMessageStartIndexes.push(index);
            turnIndexById.set(messageId, currentTurnIndex);
            userMessageToTurnIndex.set(messageId, currentTurnIndex);
            messageToTurnId.set(messageId, messageId);
            messageToTurnIndex.set(messageId, currentTurnIndex);
            return;
        }

        if (role !== 'assistant') {
            if (currentTurnIndex >= 0) {
                const turnId = turnIds[currentTurnIndex];
                if (turnId) {
                    messageToTurnId.set(messageId, turnId);
                    messageToTurnIndex.set(messageId, currentTurnIndex);
                }
            }
            return;
        }

        const parentId = resolveParentMessageId(message);
        const parentTurnIndex = parentId ? userMessageToTurnIndex.get(parentId) : undefined;
        const targetTurnIndex = typeof parentTurnIndex === 'number' ? parentTurnIndex : currentTurnIndex;
        if (targetTurnIndex < 0) {
            return;
        }

        const turnId = turnIds[targetTurnIndex];
        if (!turnId) {
            return;
        }

        messageToTurnId.set(messageId, turnId);
        messageToTurnIndex.set(messageId, targetTurnIndex);
    });

    return {
        turnIds,
        turnMessageStartIndexes,
        turnIndexById,
        messageToTurnId,
        messageToTurnIndex,
        turnCount: turnIds.length,
    };
};

export const getInitialTurnStart = (
    turnCount: number,
    initialTurns = TURN_WINDOW_DEFAULTS.initialTurns,
): number => {
    if (turnCount <= 0) {
        return 0;
    }
    return turnCount > initialTurns ? turnCount - initialTurns : 0;
};

export const clampTurnStart = (turnStart: number, turnCount: number): number => {
    if (turnCount <= 0) {
        return 0;
    }
    if (turnStart <= 0) {
        return 0;
    }
    return Math.min(turnStart, turnCount - 1);
};

export const getTurnWindowSliceStart = (
    model: Pick<TurnWindowModel, 'turnMessageStartIndexes'>,
    turnStart: number,
): number => {
    if (turnStart <= 0) {
        return 0;
    }
    const from = model.turnMessageStartIndexes[turnStart];
    return typeof from === 'number' ? from : 0;
};

export const windowMessagesByTurn = (
    messages: ChatMessageEntry[],
    model: Pick<TurnWindowModel, 'turnMessageStartIndexes'>,
    turnStart: number,
): ChatMessageEntry[] => {
    const sliceStart = getTurnWindowSliceStart(model, turnStart);
    if (sliceStart <= 0) {
        return messages;
    }
    return messages.slice(sliceStart);
};
