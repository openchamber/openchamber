import React from 'react';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { stabilizeTurnProjection } from '../lib/turns/stabilizeTurnProjection';
import type { ChatMessageEntry, TurnProjectionResult, TurnRecord } from '../lib/turns/types';
import { streamPerfMeasure } from '@/stores/utils/streamDebug';

interface UseTurnRecordsOptions {
    showTextJustificationActivity: boolean;
}

export interface TurnRecordsResult {
    projection: TurnProjectionResult;
    staticTurns: TurnProjectionResult['turns'];
    streamingTurn: TurnProjectionResult['turns'][number] | undefined;
}

export const useTurnRecords = (
    messages: ChatMessageEntry[],
    options: UseTurnRecordsOptions,
): TurnRecordsResult => {
    const previousProjectionRef = React.useRef<TurnProjectionResult | null>(null);
    const staticTurnsRef = React.useRef<TurnRecord[]>([]);
    const streamingTurnRef = React.useRef<TurnRecord | undefined>(undefined);

    React.useEffect(() => {
        previousProjectionRef.current = null;
    }, [options.showTextJustificationActivity]);

    const projection = React.useMemo(() => {
        return streamPerfMeasure('ui.turns.projection_ms', () => {
            const rawProjection = projectTurnRecords(messages, {
                previousProjection: previousProjectionRef.current,
                showTextJustificationActivity: options.showTextJustificationActivity,
            });
            const stabilizedProjection = stabilizeTurnProjection(rawProjection, previousProjectionRef.current);
            previousProjectionRef.current = stabilizedProjection;
            return stabilizedProjection;
        });
    }, [messages, options.showTextJustificationActivity]);

    const staticTurns = React.useMemo(() => {
        const nextStatic = projection.turns.length <= 1
            ? []
            : projection.turns.slice(0, -1);
        const previousStatic = staticTurnsRef.current;

        if (previousStatic.length === nextStatic.length) {
            let isSame = true;
            for (let index = 0; index < nextStatic.length; index += 1) {
                if (previousStatic[index] !== nextStatic[index]) {
                    isSame = false;
                    break;
                }
            }
            if (isSame) {
                return previousStatic;
            }
        }

        staticTurnsRef.current = nextStatic;
        return nextStatic;
    }, [projection.turns]);

    const streamingTurn = React.useMemo(() => {
        const nextStreamingTurn = projection.turns.length === 0
            ? undefined
            : projection.turns[projection.turns.length - 1];
        if (streamingTurnRef.current === nextStreamingTurn) {
            return streamingTurnRef.current;
        }
        streamingTurnRef.current = nextStreamingTurn;
        return nextStreamingTurn;
    }, [projection.turns]);

    return {
        projection,
        staticTurns,
        streamingTurn,
    };
};
