import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';
import { computeTpsText, computeTtftText } from './metricsUtils';

const base = { id: 'p1', sessionID: 's1', messageID: 'm1' };

function textPart(start: number, end: number): Part {
    return { ...base, type: 'text', text: 'hello', time: { start, end } } as Part;
}

function textPartNoTime(): Part {
    return { ...base, type: 'text', text: 'hello' } as Part;
}

function reasoningPart(start: number): Part {
    return { ...base, type: 'reasoning', text: 'thinking...', time: { start } } as Part;
}

function toolPartCompleted(start: number, end: number): Part {
    return {
        ...base,
        type: 'tool',
        callID: 'c1',
        tool: 'read',
        state: { status: 'completed', time: { start, end } },
    } as Part;
}

function toolPartRunning(start: number): Part {
    return {
        ...base,
        type: 'tool',
        callID: 'c1',
        tool: 'read',
        state: { status: 'running', time: { start } },
    } as Part;
}

function toolPartPending(): Part {
    return {
        ...base,
        type: 'tool',
        callID: 'c1',
        tool: 'read',
        state: { status: 'pending' },
    } as Part;
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
        expect(computeTpsText([toolPartCompleted(500, 900), textPart(1000, 3000)], 100)).toBe('50.0 t/s');
    });

    test('returns undefined for NaN time values', () => {
        expect(computeTpsText([textPartWithOverrides({ time: { start: NaN, end: 3000 } })], 100)).toBe(undefined);
    });

    test('returns undefined for Infinity time values', () => {
        expect(computeTpsText([textPartWithOverrides({ time: { start: 1000, end: Infinity } })], 100)).toBe(undefined);
    });
});

describe('computeTtftText', () => {
    test('returns TTFT from first text part', () => {
        expect(computeTtftText([textPart(1999, 5000)], 1000)).toBe('999ms');
        expect(computeTtftText([textPart(2000, 5000)], 1000)).toBe('1.0s');
    });

    test('returns TTFT from first reasoning part', () => {
        expect(computeTtftText([reasoningPart(1500)], 1000)).toBe('500ms');
    });

    test('returns TTFT from first tool part (completed)', () => {
        expect(computeTtftText([toolPartCompleted(1200, 3000)], 1000)).toBe('200ms');
    });

    test('returns TTFT from first tool part (running)', () => {
        expect(computeTtftText([toolPartRunning(1100)], 1000)).toBe('100ms');
    });

    test('skips tool part with pending state (no time)', () => {
        expect(computeTtftText([toolPartPending(), textPart(1999, 5000)], 1000)).toBe('999ms');
    });

    test('picks first part with time in array order', () => {
        expect(computeTtftText([reasoningPart(1200), textPart(1500, 5000)], 1000)).toBe('200ms');
    });

    test('returns undefined when no parts have time', () => {
        expect(computeTtftText([textPartNoTime()], 1000)).toBe(undefined);
    });

    test('returns undefined for empty visibleParts', () => {
        expect(computeTtftText([], 1000)).toBe(undefined);
    });

    test('returns undefined for negative TTFT', () => {
        expect(computeTtftText([textPart(500, 1000)], 1000)).toBe(undefined);
    });

    test('returns undefined for zero TTFT', () => {
        expect(computeTtftText([textPart(1000, 3000)], 1000)).toBe(undefined);
    });

    test('formats seconds for TTFT >= 1000ms', () => {
        expect(computeTtftText([textPart(3500, 5000)], 1000)).toBe('2.5s');
    });

    test('returns undefined for NaN userCreatedAt', () => {
        expect(computeTtftText([textPart(2000, 5000)], NaN)).toBe(undefined);
    });

    test('returns undefined for NaN time.start', () => {
        expect(computeTtftText([textPartWithOverrides({ time: { start: NaN } })], 1000)).toBe(undefined);
    });
});
