import React from 'react';

// Which settled Activity folds the reader opened. It outlives the list, like
// tool expansion in ChatMessage: returning to a session shows its folds as they
// were left, which a restored reading position inside an open fold depends on.
// Turn IDs are message IDs, unique across sessions. The folds only exist in
// the collapsed activity mode, so a mode switch drops everything.
const TURN_EXPANSION_CACHE_MAX = 4000;
const turnExpansionCache = new Map<string, boolean>();
let turnExpansionCacheMode: string | null = null;

const readTurnExpansionCache = (activityRenderMode: string): Map<string, boolean> => {
    if (turnExpansionCacheMode !== activityRenderMode) {
        turnExpansionCache.clear();
        turnExpansionCacheMode = activityRenderMode;
    }
    return new Map(turnExpansionCache);
};

const writeTurnExpansionCache = (turnId: string, expanded: boolean): void => {
    turnExpansionCache.delete(turnId);
    turnExpansionCache.set(turnId, expanded);
    if (turnExpansionCache.size > TURN_EXPANSION_CACHE_MAX) {
        const oldest = turnExpansionCache.keys().next().value;
        if (oldest !== undefined) turnExpansionCache.delete(oldest);
    }
};

export const useTurnExpansion = (activityRenderMode: string) => {
    const [turnExpansion, setTurnExpansion] = React.useState<Map<string, boolean>>(() => readTurnExpansionCache(activityRenderMode));

    const turnExpansionModeRef = React.useRef(activityRenderMode);
    React.useEffect(() => {
        if (turnExpansionModeRef.current === activityRenderMode) return;
        turnExpansionModeRef.current = activityRenderMode;
        setTurnExpansion(readTurnExpansionCache(activityRenderMode));
    }, [activityRenderMode]);

    const toggleTurnActivity = React.useCallback((turnId: string) => {
        setTurnExpansion((previous) => {
            const expanded = previous.get(turnId) !== true;
            writeTurnExpansionCache(turnId, expanded);
            return new Map(previous).set(turnId, expanded);
        });
    }, []);

    const turnExpansionRef = React.useRef(turnExpansion);
    turnExpansionRef.current = turnExpansion;

    /** Opens a turn's fold. False when it was already open. */
    const expandTurnActivity = React.useCallback((turnId: string): boolean => {
        if (turnExpansionRef.current.get(turnId) === true) return false;
        writeTurnExpansionCache(turnId, true);
        setTurnExpansion((previous) => new Map(previous).set(turnId, true));
        return true;
    }, []);

    return { turnExpansion, toggleTurnActivity, expandTurnActivity };
};
