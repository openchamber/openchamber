import React from 'react';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { projectTurnIndexes } from '../lib/turns/projectTurnIndexes';
import type { ChatMessageEntry, TurnProjectionResult, TurnRecord } from '../lib/turns/types';

interface UseTurnRecordsOptions {
    showTextJustificationActivity: boolean;
}

export interface TurnRecordsResult {
    projection: TurnProjectionResult;
    staticTurns: TurnProjectionResult['turns'];
    streamingTurn: TurnProjectionResult['turns'][number] | undefined;
}

const buildTurnSignature = (turn: TurnRecord): string => {
    const assistantIds = turn.assistantMessageIds.join(',');
    const activityIds = turn.activityParts.map((part) => part.id).join(',');
    const segmentIds = turn.activitySegments.map((segment) => `${segment.id}:${segment.parts.length}`).join(',');
    return [
        turn.turnId,
        turn.headerMessageId ?? '',
        assistantIds,
        activityIds,
        segmentIds,
        turn.summaryText ?? '',
        turn.stream.isStreaming ? '1' : '0',
        turn.stream.isRetrying ? '1' : '0',
        turn.completedAt ?? '',
    ].join('|');
};

const stabilizeTurnProjection = (
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

export const useTurnRecords = (
    messages: ChatMessageEntry[],
    options: UseTurnRecordsOptions,
): TurnRecordsResult => {
    const previousProjectionRef = React.useRef<TurnProjectionResult | null>(null);

    const projection = React.useMemo(() => {
        const rawProjection = projectTurnRecords(messages, {
            showTextJustificationActivity: options.showTextJustificationActivity,
        });
        const stabilizedProjection = stabilizeTurnProjection(rawProjection, previousProjectionRef.current);
        previousProjectionRef.current = stabilizedProjection;
        return stabilizedProjection;
    }, [messages, options.showTextJustificationActivity]);

    const staticTurns = React.useMemo(() => {
        if (projection.turns.length <= 1) {
            return [];
        }
        return projection.turns.slice(0, -1);
    }, [projection.turns]);

    const streamingTurn = React.useMemo(() => {
        if (projection.turns.length === 0) {
            return undefined;
        }
        return projection.turns[projection.turns.length - 1];
    }, [projection.turns]);

    return {
        projection,
        staticTurns,
        streamingTurn,
    };
};
