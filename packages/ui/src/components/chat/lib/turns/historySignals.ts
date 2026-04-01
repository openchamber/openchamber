import type { SessionMemoryState } from '@/sync/viewport-store';

export interface TurnHistorySignalsInput {
    memoryState: SessionMemoryState | null;
    loadedMessageCount: number;
    loadedTurnCount: number;
    turnStart: number;
    defaultHistoryLimit: number;
}

export interface TurnHistorySignals {
    hasBufferedTurns: boolean;
    hasMoreAboveTurns: boolean;
    historyLoading: boolean;
    canLoadEarlier: boolean;
}

const deriveHasMoreAbove = (
    memoryState: SessionMemoryState | null,
    loadedMessageCount: number,
    loadedTurnCount: number,
    defaultHistoryLimit: number,
): boolean => {
    if (!memoryState) {
        return loadedMessageCount >= defaultHistoryLimit;
    }

    if (memoryState.historyComplete === true) {
        return false;
    }

    if (memoryState.hasMoreTurnsAbove === true || memoryState.hasMoreAbove === true) {
        return true;
    }

    if (memoryState.historyComplete === false) {
        return true;
    }

    if (memoryState.hasMoreTurnsAbove === false || memoryState.hasMoreAbove === false) {
        return false;
    }

    const fallbackMessageSignal = loadedMessageCount >= defaultHistoryLimit;
    const fallbackTurnSignal = loadedTurnCount >= Math.max(1, Math.floor(defaultHistoryLimit / 2));
    return fallbackMessageSignal || fallbackTurnSignal;
};

export const deriveTurnHistorySignals = (
    input: TurnHistorySignalsInput,
): TurnHistorySignals => {
    const hasBufferedTurns = input.turnStart > 0;
    const hasMoreAboveTurns = deriveHasMoreAbove(
        input.memoryState,
        input.loadedMessageCount,
        input.loadedTurnCount,
        input.defaultHistoryLimit,
    );
    const historyLoading = Boolean(input.memoryState?.historyLoading);

    return {
        hasBufferedTurns,
        hasMoreAboveTurns,
        historyLoading,
        canLoadEarlier: hasBufferedTurns || hasMoreAboveTurns,
    };
};
