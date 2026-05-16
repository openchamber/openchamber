import { describe, expect, test } from 'bun:test';
import {
    mergeClippedIntervals,
    sumMergedDuration,
    computeMergedToolDurationMs,
    computeToolTimeBeforeTextMs,
} from './toolTimeUtils';
import type { ActivityPart } from './toolTimeUtils';

describe('mergeClippedIntervals', () => {
    test('returns empty for empty input', () => {
        expect(mergeClippedIntervals([])).toEqual([]);
    });

    test('returns single interval unchanged', () => {
        expect(mergeClippedIntervals([[100, 200]])).toEqual([[100, 200]]);
    });

    test('merges overlapping intervals', () => {
        expect(mergeClippedIntervals([[100, 200], [150, 250]])).toEqual([[100, 250]]);
    });

    test('merges adjacent intervals (touching edges)', () => {
        expect(mergeClippedIntervals([[100, 200], [200, 300]])).toEqual([[100, 300]]);
    });

    test('keeps non-overlapping intervals separate', () => {
        expect(mergeClippedIntervals([[100, 200], [300, 400]])).toEqual([[100, 200], [300, 400]]);
    });

    test('merges fully contained intervals', () => {
        expect(mergeClippedIntervals([[100, 300], [150, 200]])).toEqual([[100, 300]]);
    });

    test('handles three overlapping intervals', () => {
        expect(mergeClippedIntervals([[100, 200], [180, 280], [260, 350]])).toEqual([[100, 350]]);
    });

    test('sorts unsorted input', () => {
        expect(mergeClippedIntervals([[300, 400], [100, 200]])).toEqual([[100, 200], [300, 400]]);
    });

    test('merges parallel tool calls (identical intervals)', () => {
        expect(mergeClippedIntervals([[100, 200], [100, 200]])).toEqual([[100, 200]]);
    });
});

describe('sumMergedDuration', () => {
    test('returns 0 for empty', () => {
        expect(sumMergedDuration([])).toBe(0);
    });

    test('sums single interval', () => {
        expect(sumMergedDuration([[100, 250]])).toBe(150);
    });

    test('sums multiple non-overlapping intervals', () => {
        expect(sumMergedDuration([[100, 200], [300, 400]])).toBe(200);
    });
});

function toolPart(start: number, end: number): ActivityPart {
    return {
        kind: 'tool',
        part: { state: { time: { start, end } } },
    };
}

function nonToolPart(): ActivityPart {
    return { kind: 'text', part: {} };
}

describe('computeMergedToolDurationMs', () => {
    const windowStart = 1000;
    const windowEnd = 5000;

    test('returns undefined when activityParts is undefined', () => {
        expect(computeMergedToolDurationMs(undefined, windowStart, windowEnd)).toBe(undefined);
    });

    test('returns 0 when no tool parts exist', () => {
        expect(computeMergedToolDurationMs([nonToolPart()], windowStart, windowEnd)).toBe(0);
    });

    test('returns 0 for empty array', () => {
        expect(computeMergedToolDurationMs([], windowStart, windowEnd)).toBe(0);
    });

    test('computes single tool duration within window', () => {
        expect(computeMergedToolDurationMs([toolPart(2000, 3000)], windowStart, windowEnd)).toBe(1000);
    });

    test('clips tool extending before window', () => {
        expect(computeMergedToolDurationMs([toolPart(500, 2000)], windowStart, windowEnd)).toBe(1000);
    });

    test('clips tool extending after window', () => {
        expect(computeMergedToolDurationMs([toolPart(4000, 6000)], windowStart, windowEnd)).toBe(1000);
    });

    test('excludes tool entirely outside window (before)', () => {
        expect(computeMergedToolDurationMs([toolPart(100, 500)], windowStart, windowEnd)).toBe(0);
    });

    test('excludes tool entirely outside window (after)', () => {
        expect(computeMergedToolDurationMs([toolPart(6000, 7000)], windowStart, windowEnd)).toBe(0);
    });

    test('merges parallel tool calls (overlapping)', () => {
        const parts = [toolPart(2000, 3000), toolPart(2500, 3500)];
        expect(computeMergedToolDurationMs(parts, windowStart, windowEnd)).toBe(1500);
    });

    test('sums non-overlapping tool calls', () => {
        const parts = [toolPart(2000, 2500), toolPart(3000, 3500)];
        expect(computeMergedToolDurationMs(parts, windowStart, windowEnd)).toBe(1000);
    });

    test('skips tool parts with missing time', () => {
        const parts: ActivityPart[] = [
            { kind: 'tool', part: { state: {} } },
            toolPart(2000, 3000),
        ];
        expect(computeMergedToolDurationMs(parts, windowStart, windowEnd)).toBe(1000);
    });

    test('skips tool parts with zero-duration time', () => {
        const parts = [toolPart(2000, 2000), toolPart(3000, 4000)];
        expect(computeMergedToolDurationMs(parts, windowStart, windowEnd)).toBe(1000);
    });

    test('skips tool parts with end before start', () => {
        const parts = [toolPart(3000, 2000), toolPart(3000, 4000)];
        expect(computeMergedToolDurationMs(parts, windowStart, windowEnd)).toBe(1000);
    });
});

describe('computeToolTimeBeforeTextMs', () => {
    const messageCreatedAt = 1000;

    test('returns undefined when activityParts is undefined', () => {
        expect(computeToolTimeBeforeTextMs(undefined, messageCreatedAt, 2000)).toBe(undefined);
    });

    test('returns 0 when firstTextStart is undefined', () => {
        expect(computeToolTimeBeforeTextMs([toolPart(1000, 2000)], messageCreatedAt, undefined)).toBe(0);
    });

    test('returns 0 when text starts at or before message creation', () => {
        expect(computeToolTimeBeforeTextMs([toolPart(1000, 2000)], messageCreatedAt, 1000)).toBe(0);
        expect(computeToolTimeBeforeTextMs([toolPart(1000, 2000)], messageCreatedAt, 500)).toBe(0);
    });

    test('subtracts single tool entirely before text', () => {
        expect(computeToolTimeBeforeTextMs([toolPart(1000, 1500)], messageCreatedAt, 2000)).toBe(500);
    });

    test('clips tool that spans past first text start', () => {
        expect(computeToolTimeBeforeTextMs([toolPart(1000, 2500)], messageCreatedAt, 2000)).toBe(1000);
    });

    test('excludes tool entirely after first text', () => {
        expect(computeToolTimeBeforeTextMs([toolPart(2500, 3000)], messageCreatedAt, 2000)).toBe(0);
    });

    test('merges overlapping tools before text', () => {
        const parts = [toolPart(1000, 1500), toolPart(1400, 2000)];
        expect(computeToolTimeBeforeTextMs(parts, messageCreatedAt, 2000)).toBe(1000);
    });

    test('sums non-overlapping tools before text', () => {
        const parts = [toolPart(1000, 1200), toolPart(1500, 1700)];
        expect(computeToolTimeBeforeTextMs(parts, messageCreatedAt, 2000)).toBe(400);
    });

    test('excludes tool entirely before message creation', () => {
        expect(computeToolTimeBeforeTextMs([toolPart(500, 800)], messageCreatedAt, 2000)).toBe(0);
    });

    test('skips non-tool parts', () => {
        const parts: ActivityPart[] = [nonToolPart(), toolPart(1000, 1500)];
        expect(computeToolTimeBeforeTextMs(parts, messageCreatedAt, 2000)).toBe(500);
    });

    test('skips tool parts with end before start', () => {
        const parts = [toolPart(1500, 1000), toolPart(1000, 1500)];
        expect(computeToolTimeBeforeTextMs(parts, messageCreatedAt, 2000)).toBe(500);
    });
});
