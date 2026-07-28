/**
 * Walking back through previously sent messages with the arrow keys.
 *
 * Entering history stashes whatever was typed so leaving it returns the user's
 * own text rather than the last recalled message — the composer is not a
 * terminal, and losing a half-written prompt to an arrow key is worse than not
 * having history at all.
 *
 * Index 0 is the most recent message and higher indices are older, matching
 * how the keys read: up goes further back.
 */

import React from 'react';

/** Not browsing history. */
export const HISTORY_IDLE = -1;

export interface HistoryState {
    /** Index into the history, or HISTORY_IDLE when showing the user's draft. */
    index: number;
    /** The draft stashed on entry, restored on the way back out. */
    stashedDraft: string;
}

export const INITIAL_HISTORY_STATE: HistoryState = { index: HISTORY_IDLE, stashedDraft: '' };

/**
 * The outcome of an arrow key: the next state, and the text the composer
 * should show. A null text means the key does nothing and the composer keeps
 * what it has.
 */
export interface HistoryStep {
    state: HistoryState;
    text: string | null;
}

const unchanged = (state: HistoryState): HistoryStep => ({ state, text: null });

/** Step further back in history. `currentText` is stashed on entry. */
export function stepOlder(
    state: HistoryState,
    history: readonly string[],
    currentText: string,
): HistoryStep {
    if (history.length === 0) return unchanged(state);

    if (state.index === HISTORY_IDLE) {
        return { state: { index: 0, stashedDraft: currentText }, text: history[0] };
    }
    if (state.index >= history.length - 1) return unchanged(state);

    const index = state.index + 1;
    return { state: { ...state, index }, text: history[index] };
}

/** Step back toward the draft, restoring it once past the newest message. */
export function stepNewer(state: HistoryState, history: readonly string[]): HistoryStep {
    if (state.index === HISTORY_IDLE) return unchanged(state);

    if (state.index === 0) {
        return { state: INITIAL_HISTORY_STATE, text: state.stashedDraft };
    }

    const index = state.index - 1;
    return { state: { ...state, index }, text: history[index] };
}

export interface MessageHistory {
    /** True while showing a recalled message rather than the user's draft. */
    isBrowsing: boolean;
    /** Recall an older message; returns null when already at the oldest. */
    older: (currentText: string) => string | null;
    /** Return toward the draft; returns null when not browsing. */
    newer: () => string | null;
    /** Leave history, discarding the stashed draft. Called after a send. */
    reset: () => void;
}

export function useMessageHistory(history: readonly string[]): MessageHistory {
    const [state, setState] = React.useState<HistoryState>(INITIAL_HISTORY_STATE);

    const older = React.useCallback((currentText: string) => {
        const step = stepOlder(state, history, currentText);
        if (step.text === null) return null;
        setState(step.state);
        return step.text;
    }, [history, state]);

    const newer = React.useCallback(() => {
        const step = stepNewer(state, history);
        if (step.text === null) return null;
        setState(step.state);
        return step.text;
    }, [history, state]);

    const reset = React.useCallback(() => setState(INITIAL_HISTORY_STATE), []);

    return { isBrowsing: state.index !== HISTORY_IDLE, older, newer, reset };
}
