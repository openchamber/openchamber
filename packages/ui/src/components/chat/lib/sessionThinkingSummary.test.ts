import { describe, expect, test } from 'bun:test';
import {
    formatCompactDuration,
    formatThinkingDuration,
    hasCollapsibleActivity,
    projectSessionThinkingSummary,
    type SessionThinkingSummary,
} from './sessionThinkingSummary';
import type { TurnActivityRecord, TurnRecord } from './turns/types';

type TurnSeed = {
    hasTools?: boolean;
    hasReasoning?: boolean;
    isStreaming?: boolean;
    startedAt?: number;
    completedAt?: number;
    toolParts?: number;
};

const seedTurn = (seed: TurnSeed = {}): TurnRecord => {
    const activityParts: TurnActivityRecord[] = Array.from({ length: seed.toolParts ?? 0 }, (_, index) => ({
        id: `tool-${index}`,
        turnId: 'turn',
        messageId: 'msg',
        partIndex: index,
        kind: 'tool' as const,
        part: { type: 'tool', tool: 'bash', state: {} } as never,
    }));
    return {
        turnId: 'turn',
        userMessageId: 'u',
        userMessage: { info: { id: 'u', role: 'user' } as never, parts: [] },
        messages: [],
        assistantMessageIds: [],
        assistantMessages: [],
        activityParts,
        activitySegments: [],
        summary: {},
        hasTools: seed.hasTools ?? (seed.toolParts !== undefined && seed.toolParts > 0),
        hasReasoning: seed.hasReasoning ?? false,
        stream: { isStreaming: seed.isStreaming ?? false, isRetrying: false },
        startedAt: seed.startedAt,
        completedAt: seed.completedAt,
    } as unknown as TurnRecord;
};

describe('hasCollapsibleActivity', () => {
    test('accepts a completed turn with tools', () => {
        expect(hasCollapsibleActivity(seedTurn({ hasTools: true }))).toBe(true);
    });

    test('accepts a completed turn with reasoning', () => {
        expect(hasCollapsibleActivity(seedTurn({ hasReasoning: true }))).toBe(true);
    });

    test('rejects a streaming turn', () => {
        expect(hasCollapsibleActivity(seedTurn({ hasTools: true, isStreaming: true }))).toBe(false);
    });

    test('rejects a turn with no tool or reasoning work', () => {
        expect(hasCollapsibleActivity(seedTurn())).toBe(false);
    });
});

describe('projectSessionThinkingSummary', () => {
    test('aggregates count, tools, and the wall-clock span', () => {
        const summary = projectSessionThinkingSummary([
            seedTurn({ hasTools: true, toolParts: 3, startedAt: 1_000, completedAt: 5_000 }),
            seedTurn({ hasReasoning: true, startedAt: 6_000, completedAt: 10_000 }),
            seedTurn({ startedAt: 11_000, completedAt: 12_000 }),
            seedTurn({ hasTools: true, isStreaming: true, startedAt: 20_000, completedAt: 21_000 }),
        ]);

        expect(summary).toEqual({
            collapsedTurnCount: 2,
            toolCallCount: 3,
            startedAt: 1_000,
            completedAt: 10_000,
        });
    });

    test('returns an empty summary when nothing is collapsible', () => {
        const summary = projectSessionThinkingSummary([
            seedTurn(),
            seedTurn({ startedAt: 1, completedAt: 2 }),
        ]);
        expect(summary.collapsedTurnCount).toBe(0);
        expect(summary.toolCallCount).toBe(0);
        expect(summary.startedAt).toBe(undefined);
        expect(summary.completedAt).toBe(undefined);
    });
});

describe('formatCompactDuration', () => {
    test('formats sub-minute durations', () => {
        expect(formatCompactDuration(42_000)).toBe('42.0s');
    });

    test('formats minute durations', () => {
        expect(formatCompactDuration(3 * 60_000 + 24_000)).toBe('3m 24s');
    });

    test('formats hour durations', () => {
        expect(formatCompactDuration(2 * 3600_000 + 15 * 60_000)).toBe('2h 15m');
    });

    test('clamps negative durations to zero', () => {
        expect(formatCompactDuration(-1000)).toBe('0.0s');
    });
});

describe('formatThinkingDuration', () => {
    test('returns the wall-clock span when timestamps exist', () => {
        const summary: SessionThinkingSummary = { collapsedTurnCount: 2, toolCallCount: 1, startedAt: 1_000, completedAt: 43_000 };
        expect(formatThinkingDuration(summary)).toBe('42.0s');
    });

    test('returns null when timestamps are missing', () => {
        const summary: SessionThinkingSummary = { collapsedTurnCount: 1, toolCallCount: 0 };
        expect(formatThinkingDuration(summary)).toBeNull();
    });
});
