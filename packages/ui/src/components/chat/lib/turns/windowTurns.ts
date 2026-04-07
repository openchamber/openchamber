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

const getMessageSignature = (message: ChatMessageEntry | undefined): string | null => {
    if (!message) return null;
    const role = resolveMessageRole(message);
    const messageId = typeof message.info?.id === 'string' ? message.info.id : '';
    const parentId = resolveParentMessageId(message) ?? '';
    return `${messageId}::${role}::${parentId}`;
};

const cloneTurnWindowModel = (model: TurnWindowModel): TurnWindowModel => ({
    turnIds: [...model.turnIds],
    turnMessageStartIndexes: [...model.turnMessageStartIndexes],
    turnIndexById: new Map(model.turnIndexById),
    messageToTurnId: new Map(model.messageToTurnId),
    messageToTurnIndex: new Map(model.messageToTurnIndex),
    turnCount: model.turnCount,
});

export const updateTurnWindowModelIncremental = (
    previousModel: TurnWindowModel | null,
    previousMessages: ChatMessageEntry[] | null,
    nextMessages: ChatMessageEntry[],
): TurnWindowModel | null => {
    if (!previousModel || !previousMessages) {
        return null;
    }

    if (previousMessages.length === nextMessages.length) {
        let changedIndex = -1;
        for (let index = 0; index < nextMessages.length; index += 1) {
            if (previousMessages[index] === nextMessages[index]) {
                continue;
            }
            if (changedIndex !== -1) {
                return null;
            }
            changedIndex = index;
        }

        if (changedIndex === -1) {
            return previousModel;
        }

        if (changedIndex !== nextMessages.length - 1) {
            return null;
        }

        return getMessageSignature(previousMessages[changedIndex]) === getMessageSignature(nextMessages[changedIndex])
            ? previousModel
            : null;
    }

    if (nextMessages.length !== previousMessages.length + 1) {
        return null;
    }

    for (let index = 0; index < previousMessages.length; index += 1) {
        if (previousMessages[index] !== nextMessages[index]) {
            return null;
        }
    }

    const nextMessage = nextMessages[nextMessages.length - 1];
    if (!nextMessage) {
        return null;
    }

    const role = resolveMessageRole(nextMessage);
    const messageId = nextMessage.info.id;
    const nextModel = cloneTurnWindowModel(previousModel);

    if (role === 'user') {
        const nextTurnIndex = nextModel.turnIds.length;
        nextModel.turnIds.push(messageId);
        nextModel.turnMessageStartIndexes.push(nextMessages.length - 1);
        nextModel.turnIndexById.set(messageId, nextTurnIndex);
        nextModel.messageToTurnId.set(messageId, messageId);
        nextModel.messageToTurnIndex.set(messageId, nextTurnIndex);
        nextModel.turnCount = nextModel.turnIds.length;
        return nextModel;
    }

    if (role !== 'assistant') {
        const currentTurnIndex = nextModel.turnIds.length - 1;
        if (currentTurnIndex < 0) {
            return null;
        }
        const turnId = nextModel.turnIds[currentTurnIndex];
        if (!turnId) {
            return null;
        }
        nextModel.messageToTurnId.set(messageId, turnId);
        nextModel.messageToTurnIndex.set(messageId, currentTurnIndex);
        return nextModel;
    }

    const parentId = resolveParentMessageId(nextMessage);
    const targetTurnIndex = parentId
        ? nextModel.turnIndexById.get(parentId)
        : nextModel.turnIds.length - 1;
    if (typeof targetTurnIndex !== 'number' || targetTurnIndex < 0) {
        return null;
    }

    const turnId = nextModel.turnIds[targetTurnIndex];
    if (!turnId) {
        return null;
    }

    nextModel.messageToTurnId.set(messageId, turnId);
    nextModel.messageToTurnIndex.set(messageId, targetTurnIndex);
    return nextModel;
};

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
