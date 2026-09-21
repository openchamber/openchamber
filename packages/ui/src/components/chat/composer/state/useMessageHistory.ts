/**
 * Walking back through previously sent messages with the arrow keys.
 *
 * History arrives oldest to newest. The cursor spans `0..history.length`, with
 * `history.length` reserved for the live draft endpoint. Moving away from a
 * cursor stores the current value as an overlay for that cursor so edits survive
 * round-trips through history.
 */

import React from 'react';

export type MessageHistoryValue<TAttachment> = {
    text: string;
    attachments: readonly TAttachment[];
};

export interface HistoryState<TAttachment> {
    cursor: number;
    identity: string;
    history: readonly MessageHistoryValue<TAttachment>[];
    overlays: ReadonlyMap<number, MessageHistoryValue<TAttachment>>;
}

export interface HistoryStep<TAttachment> {
    state: HistoryState<TAttachment>;
    value: MessageHistoryValue<TAttachment> | null;
}

export interface MessageHistory<TAttachment> {
    isBrowsing: boolean;
    older: (currentValue: MessageHistoryValue<TAttachment>) => MessageHistoryValue<TAttachment> | null;
    newer: (currentValue: MessageHistoryValue<TAttachment>) => MessageHistoryValue<TAttachment> | null;
    reset: () => void;
}

function createEmptyValue<TAttachment>(): MessageHistoryValue<TAttachment> {
    return { text: '', attachments: [] };
}

function valuesEqual<TAttachment>(a: MessageHistoryValue<TAttachment>, b: MessageHistoryValue<TAttachment>): boolean {
    if (a.text !== b.text) return false;
    if (a.attachments.length !== b.attachments.length) return false;
    for (let index = 0; index < a.attachments.length; index += 1) {
        if (!Object.is(a.attachments[index], b.attachments[index])) return false;
    }
    return true;
}

function sliceEqual<TAttachment>(
    left: readonly MessageHistoryValue<TAttachment>[],
    leftStart: number,
    right: readonly MessageHistoryValue<TAttachment>[],
    rightStart: number,
    length: number,
): boolean {
    for (let index = 0; index < length; index += 1) {
        if (!valuesEqual(left[leftStart + index]!, right[rightStart + index]!)) return false;
    }
    return true;
}

function countTrimmedEntries<TAttachment>(
    previousHistory: readonly MessageHistoryValue<TAttachment>[],
    nextHistory: readonly MessageHistoryValue<TAttachment>[],
): number {
    const maxOverlap = Math.min(previousHistory.length, nextHistory.length);
    for (let overlap = maxOverlap; overlap >= 0; overlap -= 1) {
        if (sliceEqual(previousHistory, previousHistory.length - overlap, nextHistory, 0, overlap)) {
            return previousHistory.length - overlap;
        }
    }
    return previousHistory.length;
}

function readCursorValue<TAttachment>(
    cursor: number,
    history: readonly MessageHistoryValue<TAttachment>[],
    overlays: ReadonlyMap<number, MessageHistoryValue<TAttachment>>,
): MessageHistoryValue<TAttachment> {
    const overlay = overlays.get(cursor);
    if (overlay) return overlay;
    if (cursor === history.length) return createEmptyValue<TAttachment>();
    return history[cursor] ?? createEmptyValue<TAttachment>();
}

function withOverlay<TAttachment>(
    overlays: ReadonlyMap<number, MessageHistoryValue<TAttachment>>,
    cursor: number,
    value: MessageHistoryValue<TAttachment>,
): ReadonlyMap<number, MessageHistoryValue<TAttachment>> {
    const nextOverlays = new Map(overlays);
    nextOverlays.set(cursor, value);
    return nextOverlays;
}

function remapCursor(oldCursor: number, oldLength: number, newLength: number, trimmed: number): number {
    if (oldCursor === oldLength) return newLength;
    if (oldCursor < trimmed) return Math.min(newLength, 0);
    return Math.min(newLength, oldCursor - trimmed);
}

function remapOverlays<TAttachment>(
    overlays: ReadonlyMap<number, MessageHistoryValue<TAttachment>>,
    oldLength: number,
    newLength: number,
    trimmed: number,
): ReadonlyMap<number, MessageHistoryValue<TAttachment>> {
    const nextOverlays = new Map<number, MessageHistoryValue<TAttachment>>();
    for (const [cursor, value] of overlays) {
        if (cursor === oldLength) {
            nextOverlays.set(newLength, value);
            continue;
        }
        if (cursor < trimmed) continue;
        nextOverlays.set(Math.min(newLength, cursor - trimmed), value);
    }
    return nextOverlays;
}

export function createHistoryState<TAttachment>(
    history: readonly MessageHistoryValue<TAttachment>[],
    identity: string,
): HistoryState<TAttachment> {
    return {
        cursor: history.length,
        identity,
        history,
        overlays: new Map(),
    };
}

export function resetHistoryState<TAttachment>(
    state: HistoryState<TAttachment>,
    history: readonly MessageHistoryValue<TAttachment>[] = state.history,
): HistoryState<TAttachment> {
    return {
        cursor: history.length,
        identity: state.identity,
        history,
        overlays: new Map(),
    };
}

export function stepOlder<TAttachment>(
    state: HistoryState<TAttachment>,
    history: readonly MessageHistoryValue<TAttachment>[],
    currentValue: MessageHistoryValue<TAttachment>,
): HistoryStep<TAttachment> {
    if (history.length === 0 || state.cursor === 0) {
        return { state: { ...state, history }, value: null };
    }

    const overlays = withOverlay(state.overlays, state.cursor, currentValue);
    const cursor = state.cursor - 1;
    return {
        state: { ...state, cursor, history, overlays },
        value: readCursorValue(cursor, history, overlays),
    };
}

export function stepNewer<TAttachment>(
    state: HistoryState<TAttachment>,
    history: readonly MessageHistoryValue<TAttachment>[],
    currentValue: MessageHistoryValue<TAttachment>,
): HistoryStep<TAttachment> {
    if (state.cursor === history.length) {
        return { state: { ...state, history }, value: null };
    }

    const overlays = withOverlay(state.overlays, state.cursor, currentValue);
    const cursor = state.cursor + 1;
    return {
        state: { ...state, cursor, history, overlays },
        value: readCursorValue(cursor, history, overlays),
    };
}

export function syncHistoryState<TAttachment>(
    state: HistoryState<TAttachment>,
    history: readonly MessageHistoryValue<TAttachment>[],
    identity: string,
): HistoryState<TAttachment> {
    if (state.identity !== identity) {
        return createHistoryState(history, identity);
    }

    if (state.history === history) {
        return state;
    }

    const trimmed = countTrimmedEntries(state.history, history);
    return {
        cursor: remapCursor(state.cursor, state.history.length, history.length, trimmed),
        identity,
        history,
        overlays: remapOverlays(state.overlays, state.history.length, history.length, trimmed),
    };
}

export function useMessageHistory<TAttachment>(
    history: readonly MessageHistoryValue<TAttachment>[],
    identity: string,
): MessageHistory<TAttachment> {
    const [state, setState] = React.useState(() => createHistoryState(history, identity));

    React.useEffect(() => {
        setState((currentState) => syncHistoryState(currentState, history, identity));
    }, [history, identity]);

    const older = React.useCallback((currentValue: MessageHistoryValue<TAttachment>) => {
        const step = stepOlder(state, history, currentValue);
        if (step.value === null) return null;
        setState(step.state);
        return step.value;
    }, [history, state]);

    const newer = React.useCallback((currentValue: MessageHistoryValue<TAttachment>) => {
        const step = stepNewer(state, history, currentValue);
        if (step.value === null) return null;
        setState(step.state);
        return step.value;
    }, [history, state]);

    const reset = React.useCallback(() => {
        setState((currentState) => resetHistoryState(currentState, history));
    }, [history]);

    return {
        isBrowsing: state.cursor !== history.length,
        older,
        newer,
        reset,
    };
}
