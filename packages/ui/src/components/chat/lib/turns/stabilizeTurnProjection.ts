import { projectTurnIndexes } from './projectTurnIndexes';
import type { TurnProjectionResult, TurnRecord } from './types';

const areTurnMessagesReferenceStable = (previousTurn: TurnRecord, nextTurn: TurnRecord): boolean => {
    if (previousTurn.userMessage !== nextTurn.userMessage) {
        return false;
    }

    if (previousTurn.assistantMessages.length !== nextTurn.assistantMessages.length) {
        return false;
    }

    for (let index = 0; index < previousTurn.assistantMessages.length; index += 1) {
        if (previousTurn.assistantMessages[index] !== nextTurn.assistantMessages[index]) {
            return false;
        }
    }

    return true;
};

const buildTurnSignature = (turn: TurnRecord): string => {
    const assistantIds = turn.assistantMessageIds.join(',');
    return [
        turn.turnId,
        turn.headerMessageId ?? '',
        assistantIds,
        turn.summaryText ?? '',
        turn.stream.isStreaming ? '1' : '0',
        turn.stream.isRetrying ? '1' : '0',
        turn.completedAt ?? '',
    ].join('|');
};

export const stabilizeTurnProjection = (
    nextProjection: TurnProjectionResult,
    previousProjection: TurnProjectionResult | null,
): TurnProjectionResult => {
    if (!previousProjection || previousProjection.turns.length === 0 || nextProjection.turns.length === 0) {
        return nextProjection;
    }

    const previousById = new Map(previousProjection.turns.map((turn) => [turn.turnId, turn]));
    let reused = false;

    const stabilizedTurns = nextProjection.turns.map((turn, index) => {
        const isLastTurn = index === nextProjection.turns.length - 1;
        if (isLastTurn) {
            return turn;
        }

        const previousTurn = previousById.get(turn.turnId);
        if (!previousTurn) {
            return turn;
        }

        if (buildTurnSignature(previousTurn) !== buildTurnSignature(turn)) {
            return turn;
        }

        if (!areTurnMessagesReferenceStable(previousTurn, turn)) {
            return turn;
        }

        reused = true;
        return previousTurn;
    });

    if (!reused) {
        return nextProjection;
    }

    const projection = projectTurnIndexes(stabilizedTurns);
    return {
        ...projection,
        ungroupedMessageIds: nextProjection.ungroupedMessageIds,
    };
};
