import type { TurnRecord } from './turns/types';

/**
 * Aggregated summary of the completed working turns that are folded into the
 * session-level "Thinking" block once a session goes idle.
 */
export interface SessionThinkingSummary {
    /** Number of completed turns whose assistant work is collapsed. */
    collapsedTurnCount: number;
    /** Number of tool-call activity parts across the collapsed turns. */
    toolCallCount: number;
    /** Earliest work start across collapsed turns (epoch ms). */
    startedAt?: number;
    /** Latest work completion across collapsed turns (epoch ms). */
    completedAt?: number;
}

/** A turn is collapsible when it has tool/reasoning work and is fully done. */
export const hasCollapsibleActivity = (turn: TurnRecord): boolean =>
    (turn.hasTools || turn.hasReasoning) && !turn.stream.isStreaming;

export const projectSessionThinkingSummary = (turns: TurnRecord[]): SessionThinkingSummary => {
    let collapsedTurnCount = 0;
    let toolCallCount = 0;
    let startedAt: number | undefined;
    let completedAt: number | undefined;

    for (const turn of turns) {
        if (!hasCollapsibleActivity(turn)) {
            continue;
        }
        collapsedTurnCount += 1;
        toolCallCount += turn.activityParts.filter((activity) => activity.kind === 'tool').length;
        if (typeof turn.startedAt === 'number') {
            startedAt = startedAt === undefined ? turn.startedAt : Math.min(startedAt, turn.startedAt);
        }
        if (typeof turn.completedAt === 'number') {
            completedAt = completedAt === undefined ? turn.completedAt : Math.max(completedAt, turn.completedAt);
        }
    }

    return { collapsedTurnCount, toolCallCount, startedAt, completedAt };
};

/**
 * Compact duration like "42.4s" / "3m 24s" / "2h 15m", matching the
 * turn-duration display used elsewhere in the chat UI. Boundary spans are
 * rounded on the total first so they never emit "59m 60s" or "60.0s", while
 * sub-minute spans keep one decimal of precision.
 */
export const formatCompactDuration = (durationMs: number): string => {
    const totalSeconds = Math.max(0, durationMs) / 1000;
    const roundedSeconds = Math.round(totalSeconds);
    if (roundedSeconds < 60) {
        return `${totalSeconds.toFixed(1)}s`;
    }
    const hours = Math.floor(roundedSeconds / 3600);
    const minutes = Math.floor((roundedSeconds % 3600) / 60);
    const seconds = roundedSeconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
};

/**
 * Wall-clock span of the collapsed working phase (earliest start → latest
 * completion). Returns null when the timestamps are unavailable.
 */
export const formatThinkingDuration = (summary: SessionThinkingSummary): string | null => {
    if (typeof summary.startedAt !== 'number' || typeof summary.completedAt !== 'number') {
        return null;
    }
    const span = summary.completedAt - summary.startedAt;
    if (!(span > 0)) {
        return null;
    }
    return formatCompactDuration(span);
};
