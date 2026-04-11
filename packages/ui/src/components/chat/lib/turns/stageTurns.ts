import React from 'react';

export interface TurnStageConfig {
    init: number;
    batch: number;
}

export interface UseStageTurnsOptions {
    sessionKey: string;
    turnStart: number;
    totalTurns: number;
    config?: Partial<TurnStageConfig>;
    disabled?: boolean;
}

export interface StageTurnsResult {
    stagedCount: number;
    stageStartIndex: number;
    isStaging: boolean;
}

const DEFAULT_STAGE_CONFIG: TurnStageConfig = {
    init: 10,
    batch: 8,
};

export const getInitialStageCount = (total: number, config: TurnStageConfig): number => {
    if (total <= 0) {
        return 0;
    }
    return Math.min(total, Math.max(1, config.init));
};

export const getNextStageCount = (current: number, total: number, config: TurnStageConfig): number => {
    if (total <= 0) {
        return 0;
    }
    const batch = Math.max(1, config.batch);
    return Math.min(total, current + batch);
};

export const getStageStartIndex = (total: number, stagedCount: number): number => {
    if (stagedCount >= total) {
        return 0;
    }
    return Math.max(0, total - stagedCount);
};

export const useStageTurns = ({
    sessionKey,
    turnStart,
    totalTurns,
    config,
    disabled,
}: UseStageTurnsOptions): StageTurnsResult => {
    const effectiveConfig = React.useMemo<TurnStageConfig>(() => {
        return {
            init: config?.init ?? DEFAULT_STAGE_CONFIG.init,
            batch: config?.batch ?? DEFAULT_STAGE_CONFIG.batch,
        };
    }, [config?.batch, config?.init]);

    const [state, setState] = React.useState(() => ({
        activeSession: '',
        completedSession: '',
        count: totalTurns,
    }));

    const stateRef = React.useRef(state);
    React.useEffect(() => {
        stateRef.current = state;
    }, [state]);

    React.useEffect(() => {
        let frameId: number | null = null;
        const snapshot = stateRef.current;
        const shouldStage =
            !disabled
            && turnStart > 0
            && totalTurns > effectiveConfig.init
            && snapshot.completedSession !== sessionKey
            && snapshot.activeSession !== sessionKey;

        if (!shouldStage) {
            setState((previous) => {
                if (previous.count === totalTurns && previous.activeSession === '') {
                    return previous;
                }
                return {
                    ...previous,
                    activeSession: '',
                    count: totalTurns,
                };
            });
            return () => {
                if (frameId !== null && typeof window !== 'undefined') {
                    window.cancelAnimationFrame(frameId);
                }
            };
        }

        let nextCount = getInitialStageCount(totalTurns, effectiveConfig);
        setState((previous) => ({
            ...previous,
            activeSession: sessionKey,
            count: nextCount,
        }));

        const step = () => {
            nextCount = getNextStageCount(nextCount, totalTurns, effectiveConfig);
            setState((previous) => ({
                ...previous,
                count: nextCount,
            }));

            if (nextCount >= totalTurns) {
                setState((previous) => ({
                    ...previous,
                    completedSession: sessionKey,
                    activeSession: '',
                    count: totalTurns,
                }));
                frameId = null;
                return;
            }

            frameId = window.requestAnimationFrame(step);
        };

        if (typeof window !== 'undefined') {
            frameId = window.requestAnimationFrame(step);
        }

        return () => {
            if (frameId !== null && typeof window !== 'undefined') {
                window.cancelAnimationFrame(frameId);
            }
        };
    }, [disabled, effectiveConfig, sessionKey, totalTurns, turnStart]);

    const stagedCount = React.useMemo(() => {
        if (turnStart <= 0 || disabled) {
            return totalTurns;
        }
        if (state.completedSession === sessionKey) {
            return totalTurns;
        }
        if (state.count <= 0) {
            return getInitialStageCount(totalTurns, effectiveConfig);
        }
        return Math.min(totalTurns, state.count);
    }, [disabled, effectiveConfig, sessionKey, state.completedSession, state.count, totalTurns, turnStart]);

    return {
        stagedCount,
        stageStartIndex: getStageStartIndex(totalTurns, stagedCount),
        isStaging: !disabled && turnStart > 0 && state.activeSession === sessionKey && state.completedSession !== sessionKey,
    };
};
