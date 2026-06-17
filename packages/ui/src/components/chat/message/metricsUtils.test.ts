import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';
import { computeTpsText, computeTtftText, computeEarliestPartStart } from './metricsUtils';

const base = { id: 'p1', sessionID: 's1', messageID: 'm1' };

function textPart(start: number, end: number): Part {
    return { ...base, type: 'text', text: 'hello', time: { start, end } } as Part;
}

function textPartNoTime(): Part {
    return { ...base, type: 'text', text: 'hello' } as Part;
}

function textPartWithOverrides(overrides: Record<string, unknown>): Part {
    return { ...base, type: 'text', text: 'x', ...overrides } as Part;
}

describe('computeTpsText', () => {
    test('returns undefined for zero outputTokens', () => {
        expect(computeTpsText([textPart(1000, 3000)], 0)).toBe(undefined);
    });

    test('returns undefined for negative outputTokens', () => {
        expect(computeTpsText([textPart(1000, 3000)], -1)).toBe(undefined);
    });

    test('returns undefined when no text parts have time', () => {
        expect(computeTpsText([textPartNoTime()], 100)).toBe(undefined);
    });

    test('returns undefined when visibleParts is empty', () => {
        expect(computeTpsText([], 100)).toBe(undefined);
    });

    test('returns undefined for duration < 100ms', () => {
        expect(computeTpsText([textPart(1000, 1050)], 100)).toBe(undefined);
    });

    test('computes TPS for single text part', () => {
        expect(computeTpsText([textPart(1000, 3000)], 100)).toBe('50.0 t/s');
    });

    test('returns undefined when multiple text parts have time', () => {
        expect(computeTpsText([textPart(1000, 2000), textPart(3000, 5000)], 100)).toBe(undefined);
    });

    test('skips tool parts', () => {
        expect(computeTpsText([{ ...base, type: 'tool', callID: 'c1', tool: 'read', state: { status: 'completed', time: { start: 500, end: 900 } } } as Part, textPart(1000, 3000)], 100)).toBe('50.0 t/s');
    });

    test('returns undefined when reasoning part with time.start is present', () => {
        const reasoning: Part = { ...base, type: 'reasoning', text: 'thinking', time: { start: 500, end: 900 } } as Part;
        expect(computeTpsText([reasoning, textPart(1000, 3000)], 100)).toBe(undefined);
    });

    test('returns TPS when reasoning part lacks time field', () => {
        const reasoning: Part = { ...base, type: 'reasoning', text: 'thinking' } as Part;
        expect(computeTpsText([reasoning, textPart(1000, 3000)], 100)).toBe('50.0 t/s');
    });

    test('returns undefined when reasoning part has time.start but no end', () => {
        const reasoning: Part = { ...base, type: 'reasoning', text: 'thinking', time: { start: 500 } } as Part;
        expect(computeTpsText([reasoning, textPart(1000, 3000)], 100)).toBe(undefined);
    });

    test('returns undefined for NaN time values', () => {
        expect(computeTpsText([textPartWithOverrides({ time: { start: NaN, end: 3000 } })], 100)).toBe(undefined);
    });

    test('returns undefined for Infinity time values', () => {
        expect(computeTpsText([textPartWithOverrides({ time: { start: 1000, end: Infinity } })], 100)).toBe(undefined);
    });
});

describe('computeTtftText', () => {
    test('returns TTFT from earliest part start', () => {
        expect(computeTtftText(1999, 1000)).toBe('999ms');
        expect(computeTtftText(2000, 1000)).toBe('1.0s');
    });

    test('returns TTFT from tool part start (sleep-30s pattern)', () => {
        expect(computeTtftText(2000, 1000)).toBe('1.0s');
    });

    test('returns undefined when earliestPartStart is undefined', () => {
        expect(computeTtftText(undefined, 1000)).toBe(undefined);
    });

    test('returns undefined when userCreatedAt is undefined', () => {
        expect(computeTtftText(2000, undefined)).toBe(undefined);
    });

    test('returns undefined for negative TTFT', () => {
        expect(computeTtftText(500, 1000)).toBe(undefined);
    });

    test('returns undefined for zero TTFT', () => {
        expect(computeTtftText(1000, 1000)).toBe(undefined);
    });

    test('formats seconds for TTFT >= 1000ms', () => {
        expect(computeTtftText(3500, 1000)).toBe('2.5s');
    });

    test('returns undefined for NaN earliestPartStart', () => {
        expect(computeTtftText(NaN, 1000)).toBe(undefined);
    });

    test('returns undefined for NaN userCreatedAt', () => {
        expect(computeTtftText(2000, NaN)).toBe(undefined);
    });

    test('returns undefined for Infinity earliestPartStart', () => {
        expect(computeTtftText(Infinity, 1000)).toBe(undefined);
    });
});

describe('computeEarliestPartStart', () => {
    function toolPart(status: string, start?: number, end?: number): Part {
        const state: Record<string, unknown> = { status };
        if (start !== undefined) {
            const time: Record<string, unknown> = { start };
            if (end !== undefined) time.end = end;
            state.time = time;
        }
        return { ...base, type: 'tool', callID: 'c1', tool: 'read', state } as Part;
    }

    function reasoningPart(start: number, end?: number): Part {
        return { ...base, type: 'reasoning', text: 'thinking', time: { start, ...(end !== undefined ? { end } : {}) } } as Part;
    }

    test('returns undefined for empty messages', () => {
        expect(computeEarliestPartStart([])).toBe(undefined);
    });

    test('returns text part start from single message', () => {
        expect(computeEarliestPartStart([{ parts: [textPart(3000, 5000)] }])).toBe(3000);
    });

    test('returns earliest across multiple parts', () => {
        expect(computeEarliestPartStart([{ parts: [textPart(5000, 7000), reasoningPart(2000, 4000)] }])).toBe(2000);
    });

    test('picks tool part state.time.start', () => {
        expect(computeEarliestPartStart([{ parts: [toolPart('completed', 1500, 3000), textPart(4000, 6000)] }])).toBe(1500);
    });

    test('picks earliest across multiple messages (sleep-30s pattern)', () => {
        const msg1 = { parts: [toolPart('completed', 2000, 32000)] };
        const msg2 = { parts: [textPart(33000, 35000)] };
        expect(computeEarliestPartStart([msg1, msg2])).toBe(2000);
    });

    test('skips tool part with pending state (no time)', () => {
        expect(computeEarliestPartStart([{ parts: [toolPart('pending'), textPart(4000, 6000)] }])).toBe(4000);
    });

    test('skips tool part with running state and NaN start', () => {
        expect(computeEarliestPartStart([{ parts: [toolPart('running', NaN), textPart(4000, 6000)] }])).toBe(4000);
    });

    test('skips tool part with Infinity start', () => {
        expect(computeEarliestPartStart([{ parts: [toolPart('completed', Infinity, 9000), textPart(4000, 6000)] }])).toBe(4000);
    });

    test('returns undefined when no parts have time', () => {
        expect(computeEarliestPartStart([{ parts: [textPartNoTime(), toolPart('pending')] }])).toBe(undefined);
    });

    test('returns undefined for messages with empty parts', () => {
        expect(computeEarliestPartStart([{ parts: [] }])).toBe(undefined);
    });
});
