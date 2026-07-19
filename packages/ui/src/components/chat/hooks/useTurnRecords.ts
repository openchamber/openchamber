import React from 'react';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnProjectionResult, TurnRecord } from '../lib/turns/types';
import { buildProjectionCacheKey, getCachedProjection, setCachedProjection } from '../lib/turns/turnProjectionCache';
import { streamPerfMeasure } from '@/stores/utils/streamDebug';

interface UseTurnRecordsOptions {
    sessionKey?: string;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
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
    const previousSessionKeyRef = React.useRef<string | undefined>(options.sessionKey);
    const previousShowTextJustificationActivityRef = React.useRef(options.showTextJustificationActivity);
    const previousShowTurnChangedFilesRef = React.useRef(options.showTurnChangedFiles);

    if (
        previousSessionKeyRef.current !== options.sessionKey
        || previousShowTextJustificationActivityRef.current !== options.showTextJustificationActivity
        || previousShowTurnChangedFilesRef.current !== options.showTurnChangedFiles
    ) {
        previousSessionKeyRef.current = options.sessionKey;
        previousShowTextJustificationActivityRef.current = options.showTextJustificationActivity;
        previousShowTurnChangedFilesRef.current = options.showTurnChangedFiles;
        previousProjectionRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnRef.current = undefined;
    }

    React.useEffect(() => {
        previousProjectionRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnRef.current = undefined;
    }, [options.sessionKey, options.showTextJustificationActivity, options.showTurnChangedFiles]);

    const projection = React.useMemo(() => {
        const sessionKey = options.sessionKey ?? '';
        const cacheKey = buildProjectionCacheKey(
            sessionKey,
            messages,
            options.showTextJustificationActivity,
            options.showTurnChangedFiles,
        );
        const cached = getCachedProjection(cacheKey);
        if (cached) {
            previousProjectionRef.current = cached;
            return cached;
        }

        return streamPerfMeasure('ui.turns.projection_ms', () => {
            const nextProjection = projectTurnRecords(messages, {
                previousProjection: previousProjectionRef.current,
                showTextJustificationActivity: options.showTextJustificationActivity,
                showTurnChangedFiles: options.showTurnChangedFiles,
            });
            previousProjectionRef.current = nextProjection;

            setCachedProjection(cacheKey, nextProjection);

            return nextProjection;
        });
    }, [messages, options.showTextJustificationActivity, options.showTurnChangedFiles, options.sessionKey]);

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
