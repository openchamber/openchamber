import React from 'react';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { projectTurnIndexes } from '../lib/turns/projectTurnIndexes';
import { stabilizeTurnProjection } from '../lib/turns/stabilizeTurnProjection';
import type { ChatMessageEntry, TurnProjectionResult, TurnRecord } from '../lib/turns/types';
import { streamPerfMeasure } from '@/stores/utils/streamDebug';

interface UseTurnRecordsOptions {
    sessionKey?: string;
    showTextJustificationActivity: boolean;
}

export interface TurnRecordsResult {
    projection: TurnProjectionResult;
    staticTurns: TurnProjectionResult['turns'];
    streamingTurn: TurnProjectionResult['turns'][number] | undefined;
}

const buildTailOnlyProjection = (
    previousProjection: TurnProjectionResult | null,
    previousMessages: ChatMessageEntry[] | null,
    nextMessages: ChatMessageEntry[],
    showTextJustificationActivity: boolean,
): TurnProjectionResult | null => {
    if (!previousProjection || !previousMessages || previousProjection.turns.length === 0) {
        return null;
    }

    if (previousMessages.length !== nextMessages.length || nextMessages.length === 0) {
        return null;
    }

    let changedCount = 0;
    let changedIndex = -1;
    for (let index = 0; index < nextMessages.length; index += 1) {
        if (previousMessages[index]?.info.id !== nextMessages[index]?.info.id) {
            return null;
        }
        if (previousMessages[index] !== nextMessages[index]) {
            changedCount += 1;
            changedIndex = index;
            if (changedCount > 1) {
                return null;
            }
        }
    }

    if (changedCount !== 1 || changedIndex !== nextMessages.length - 1) {
        return null;
    }

    const previousLastTurn = previousProjection.turns[previousProjection.turns.length - 1];
    if (!previousLastTurn) {
        return null;
    }

    const lastTurnStartIndex = previousMessages.findIndex((message) => message.info.id === previousLastTurn.userMessageId);
    if (lastTurnStartIndex < 0) {
        return null;
    }

    const previousTailMessages = previousMessages.slice(lastTurnStartIndex);
    const nextTailMessages = nextMessages.slice(lastTurnStartIndex);
    if (nextTailMessages[0]?.info.id !== previousLastTurn.userMessageId) {
        return null;
    }

    const previousStaticTurns = previousProjection.turns.slice(0, -1);
    const previousStaticUngrouped = new Set(previousProjection.ungroupedMessageIds);
    previousTailMessages.forEach((message) => {
        previousStaticUngrouped.delete(message.info.id);
    });

    const previousTailUngrouped = new Set<string>();
    previousTailMessages.forEach((message) => {
        if (previousProjection.ungroupedMessageIds.has(message.info.id)) {
            previousTailUngrouped.add(message.info.id);
        }
    });

    const previousTailProjection: TurnProjectionResult = {
        ...projectTurnIndexes([previousLastTurn]),
        ungroupedMessageIds: previousTailUngrouped,
    };

    const rawTailProjection = projectTurnRecords(nextTailMessages, {
        previousProjection: previousTailProjection,
        showTextJustificationActivity,
    });
    const stabilizedTailProjection = stabilizeTurnProjection(rawTailProjection, previousTailProjection);
    const turns = previousStaticTurns.length > 0
        ? [...previousStaticTurns, ...stabilizedTailProjection.turns]
        : stabilizedTailProjection.turns;
    const projection = projectTurnIndexes(turns);
    const ungroupedMessageIds = new Set(previousStaticUngrouped);
    stabilizedTailProjection.ungroupedMessageIds.forEach((messageId) => {
        ungroupedMessageIds.add(messageId);
    });

    return {
        ...projection,
        ungroupedMessageIds,
    };
};

export const useTurnRecords = (
    messages: ChatMessageEntry[],
    options: UseTurnRecordsOptions,
): TurnRecordsResult => {
    const previousProjectionRef = React.useRef<TurnProjectionResult | null>(null);
    const previousMessagesRef = React.useRef<ChatMessageEntry[] | null>(null);
    const staticTurnsRef = React.useRef<TurnRecord[]>([]);
    const streamingTurnRef = React.useRef<TurnRecord | undefined>(undefined);

    React.useEffect(() => {
        previousProjectionRef.current = null;
        previousMessagesRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnRef.current = undefined;
    }, [options.sessionKey, options.showTextJustificationActivity]);

    const projection = React.useMemo(() => {
        return streamPerfMeasure('ui.turns.projection_ms', () => {
            const tailOnlyProjection = buildTailOnlyProjection(
                previousProjectionRef.current,
                previousMessagesRef.current,
                messages,
                options.showTextJustificationActivity,
            );
            const rawProjection = tailOnlyProjection ?? projectTurnRecords(messages, {
                previousProjection: previousProjectionRef.current,
                showTextJustificationActivity: options.showTextJustificationActivity,
            });
            const stabilizedProjection = stabilizeTurnProjection(rawProjection, previousProjectionRef.current);
            previousProjectionRef.current = stabilizedProjection;
            previousMessagesRef.current = messages;
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
