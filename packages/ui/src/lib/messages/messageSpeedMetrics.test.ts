import { describe, expect, test } from 'bun:test';

import {
    deriveMessageSpeedMetrics,
    formatDurationMs,
    formatThroughput,
} from './messageSpeedMetrics';

describe('deriveMessageSpeedMetrics', () => {
    test('returns null when there are no tokens or part times', () => {
        expect(deriveMessageSpeedMetrics({ parts: [] })).toBeNull();
    });

    test('uses last step-finish tokens and first part start for TTFT', () => {
        const metrics = deriveMessageSpeedMetrics({
            createdAt: 1_000,
            completedAt: 6_000,
            parts: [
                { type: 'reasoning', time: { start: 2_240, end: 3_000 } },
                { type: 'text', time: { start: 3_100, end: 4_500 } },
                {
                    type: 'step-finish',
                    tokens: { input: 794, output: 251, reasoning: 258, cache: { read: 221_696, write: 0 } },
                },
            ],
        });

        expect(metrics).not.toBeNull();
        expect(metrics?.ttftMs).toBe(1_240);
        expect(metrics?.input).toBe(794);
        expect(metrics?.cacheRead).toBe(221_696);
        expect(metrics?.output).toBe(251);
        expect(metrics?.reasoning).toBe(258);
        // stream window = 4500 - 2240 = 2260ms → 251 / 2.26 ≈ 111.06
        expect(Math.abs((metrics?.throughputTps ?? 0) - 251 / 2.26) < 1e-6).toBe(true);
    });

    test('falls back to message.tokens when step-finish is missing', () => {
        const metrics = deriveMessageSpeedMetrics({
            createdAt: 10,
            completedAt: 110,
            tokens: { input: 12, output: 20, reasoning: 0, cache: { read: 8 } },
            parts: [{ type: 'text', time: { start: 30, end: 90 } }],
        });
        expect(metrics?.input).toBe(12);
        expect(metrics?.cacheRead).toBe(8);
        expect(metrics?.ttftMs).toBe(20);
        expect(Math.abs((metrics?.throughputTps ?? 0) - 20 / 0.06) < 1e-6).toBe(true);
    });

    test('falls back to e2e duration when part end times are missing', () => {
        const metrics = deriveMessageSpeedMetrics({
            createdAt: 0,
            completedAt: 2_000,
            tokens: { input: 1, output: 40, cache: { read: 0 } },
            parts: [{ type: 'text', time: { start: 500 } }],
        });
        expect(metrics?.ttftMs).toBe(500);
        expect(metrics?.throughputTps).toBe(20);
    });

    test('ignores first-part timestamps before message creation', () => {
        const metrics = deriveMessageSpeedMetrics({
            createdAt: 100,
            tokens: { input: 3, output: 1 },
            parts: [{ type: 'text', time: { start: 50, end: 150 } }],
        });
        expect(metrics?.ttftMs).toBeNull();
    });
});

describe('formatDurationMs', () => {
    test('uses two decimals under 10s', () => {
        expect(formatDurationMs(2060)).toBe('2.06s');
    });

    test('uses one decimal under 60s', () => {
        expect(formatDurationMs(12_400)).toBe('12.4s');
    });
});

describe('formatThroughput', () => {
    test('keeps one decimal for larger rates', () => {
        expect(formatThroughput(30.46)).toBe('30.5');
    });
});
