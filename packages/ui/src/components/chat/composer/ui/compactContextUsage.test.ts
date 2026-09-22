import { describe, expect, test } from 'bun:test';

import type { ContextFillMessage } from '@/stores/utils/tokenUtils';

import {
    computeCompactContextUsage,
    formatCompactContextSummary,
    getCompactContextTone,
} from './compactContextUsage';

const assistant = (tokens: ContextFillMessage['tokens'], id = 'message'): ContextFillMessage => ({
    id,
    role: 'assistant',
    tokens,
});

const compaction = (id = 'compaction'): ContextFillMessage => ({
    id,
    role: 'assistant',
    summary: true,
    finish: 'stop',
});

const measured = (usage: ReturnType<typeof computeCompactContextUsage>) => {
    if (usage.state !== 'measured') throw new Error(`expected a measured reading, got ${usage.reason}`);
    return usage;
};

describe('computeCompactContextUsage', () => {
    test('uses the latest server-reported total for the session fill', () => {
        const usage = computeCompactContextUsage(
            [
                assistant({ total: 30_000, input: 30_000 }, 'old'),
                assistant({ total: 75_000, input: 1_000, cache: { read: 200_000 } }, 'latest'),
            ],
            100_000,
        );

        expect(measured(usage)).toMatchObject({
            totalTokens: 75_000,
            contextLimit: 100_000,
            percentage: 75,
        });
    });

    for (const [label, totalTokens, tone] of [
        ['below warning', 74_999, 'neutral'],
        ['warning threshold', 75_000, 'warning'],
        ['below error', 89_999, 'warning'],
        ['error threshold', 90_000, 'error'],
    ] as const) {
        test(`uses the ${label} tone`, () => {
            const usage = computeCompactContextUsage([assistant({ total: totalTokens })], 100_000);
            expect(getCompactContextTone(usage)).toBe(tone);
        });
    }

    test('keeps a missing limit neutral instead of rendering zero usage', () => {
        const usage = computeCompactContextUsage([assistant({ total: 10_000 })], 0);

        expect(usage).toEqual({ state: 'unknown', reason: 'missing-limit' });
        expect(getCompactContextTone(usage)).toBe('neutral');
    });

    test('keeps an unread context neutral', () => {
        const usage = computeCompactContextUsage([], 100_000);

        expect(usage).toEqual({ state: 'unknown', reason: 'no-reading' });
        expect(getCompactContextTone(usage)).toBe('neutral');
    });

    test('keeps a compacted context unknown and neutral, even without a limit', () => {
        const usage = computeCompactContextUsage([assistant({ total: 40_000 }), compaction()], 0);

        expect(usage).toEqual({ state: 'unknown', reason: 'compacted' });
        expect(getCompactContextTone(usage)).toBe('neutral');
    });

    test('formats percent used first, followed by used and context limit', () => {
        const usage = computeCompactContextUsage([assistant({ total: 75_000 })], 100_000);

        const summary = formatCompactContextSummary(usage, (key, params) => {
            if (key === 'contextUsage.compact.summary') {
                return `${params?.percent} used · ${params?.used} / ${params?.limit} context limit`;
            }
            if (key === 'contextUsage.compacted.description') return 'Context compacted.';
            return 'Context usage';
        });

        expect(summary).toBe('75.0% used · 75K / 100K context limit');
        expect(summary).not.toContain('remaining');
    });

    test('keeps unknown and compacted summaries neutral and accessible', () => {
        const translate = (
            key: 'contextUsage.compact.summary' | 'contextUsage.compacted.description' | 'contextUsage.aria.label',
            params?: { used?: string; limit?: string; percent?: string },
        ) => {
            if (key === 'contextUsage.compacted.description') return 'Context compacted.';
            if (key === 'contextUsage.aria.label') return 'Context usage';
            return `${params?.percent} used · ${params?.used} / ${params?.limit} context limit`;
        };
        const compacted = computeCompactContextUsage([compaction()], 100_000);
        const missing = computeCompactContextUsage([assistant({ total: 10_000 })], 0);

        expect(formatCompactContextSummary(compacted, translate)).toBe('Context compacted.');
        expect(formatCompactContextSummary(missing, translate)).toBe('Context usage: —');
    });
});
