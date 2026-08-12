import { describe, expect, test } from 'bun:test';
import {
    clampScrollTarget,
    computeAnchorDelta,
    computeTargetScrollTop,
    diffMountedRows,
    extendHeldRange,
    initHeldRange,
    type ResizeFrameLayout,
    type ResizeLayoutTransaction,
} from './conversationResizeLayout';

// Build a frame with real mounted-row heights and an anchor document top.
const frame = (
    anchorKey: string,
    anchorDocumentTop: number,
    rows: Array<[string, number | null, number]>,
): ResizeFrameLayout => ({
    anchorKey,
    anchorDocumentTop,
    mountedRows: new Map(rows.map(([key, virtualIndex, height]) => [key, { key, virtualIndex, height }])),
    mountedStart: rows.length ? Math.min(...rows.map(([, i]) => i ?? 0)) : null,
    mountedEnd: rows.length ? Math.max(...rows.map(([, i]) => i ?? 0)) : null,
});

const makeTx = (previousLayout: ResizeFrameLayout): ResizeLayoutTransaction => ({
    transactionId: 1,
    anchorKey: previousLayout.anchorKey,
    anchorVirtualIndex: 2,
    capturedViewportTop: 300,
    previousLayout,
    state: 'active',
});

describe('conversationResizeLayout sequential frames (ONE transaction)', () => {
    test('previous row +10 -> 0 (no change) -> +5 gives targets 510 -> 510 -> 515', () => {
        // Frame 1: rows above the anchor grew 10px -> anchor doc top 300 -> 310.
        let tx = makeTx(frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150]]));
        let next = frame('c', 310, [['a', 0, 110], ['b', 1, 200], ['c', 2, 150]]);
        let delta = computeAnchorDelta(next, tx.previousLayout);
        expect(delta).toBe(10);
        let target = computeTargetScrollTop(500, delta);
        expect(target).toBe(510);
        // Commit: update the transaction's previous layout.
        tx = { ...tx, previousLayout: next };

        // Frame 2: no real change -> delta 0 -> target = current scrollTop (510).
        next = frame('c', 310, [['a', 0, 110], ['b', 1, 200], ['c', 2, 150]]);
        delta = computeAnchorDelta(next, tx.previousLayout);
        expect(delta).toBe(0);
        target = computeTargetScrollTop(510, delta);
        expect(target).toBe(510);
        tx = { ...tx, previousLayout: next };

        // Frame 3: another +5 growth -> delta +5 -> target 515 (NOT 525).
        next = frame('c', 315, [['a', 0, 115], ['b', 1, 200], ['c', 2, 150]]);
        delta = computeAnchorDelta(next, tx.previousLayout);
        expect(delta).toBe(5);
        target = computeTargetScrollTop(510, delta);
        expect(target).toBe(515);
    });

    test('cache/DOM initial mismatch but identical consecutive real heights -> zero change', () => {
        // First frame's real heights differ from the cache, but frame 2 has the
        // SAME real heights as frame 1 -> diffMountedRows is empty.
        const tx = makeTx(frame('c', 300, [['a', 0, 120], ['b', 1, 210], ['c', 2, 150]]));
        const next = frame('c', 300, [['a', 0, 120], ['b', 1, 210], ['c', 2, 150]]);
        expect(diffMountedRows(tx.previousLayout, next)).toEqual([]);
        expect(computeAnchorDelta(next, tx.previousLayout)).toBe(0);
    });

    test('anchor row itself grows -> anchor delta 0', () => {
        const tx = makeTx(frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150]]));
        const next = frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 400]]);
        expect(computeAnchorDelta(next, tx.previousLayout)).toBe(0);
    });

    test('rows AFTER the anchor grow -> anchor delta 0', () => {
        const tx = makeTx(frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150], ['d', 3, 150]]));
        const next = frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150], ['d', 3, 400]]);
        expect(computeAnchorDelta(next, tx.previousLayout)).toBe(0);
    });

    test('multiple rows above grow/shrink simultaneously -> single frame delta sum', () => {
        const tx = makeTx(frame('d', 500, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150], ['d', 3, 150]]));
        // a +20, b -10 -> anchor top 500 -> 510.
        const next = frame('d', 510, [['a', 0, 120], ['b', 1, 190], ['c', 2, 150], ['d', 3, 150]]);
        expect(computeAnchorDelta(next, tx.previousLayout)).toBe(10);
        expect(computeTargetScrollTop(500, 10)).toBe(510);
    });

    test('same-width final frame -> zero commit, zero write', () => {
        const tx = makeTx(frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150]]));
        const next = frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150]]);
        expect(diffMountedRows(tx.previousLayout, next)).toEqual([]);
        expect(computeAnchorDelta(next, tx.previousLayout)).toBe(0);
    });
});

describe('conversationResizeLayout clamp (no release)', () => {
    test('target beyond max clamps and flags clamped state', () => {
        const r = clampScrollTarget(1200, 1000, 500);
        expect(r.target).toBe(500);
        expect(r.clamped).toBe(true);
    });

    test('target below 0 clamps to 0', () => {
        const r = clampScrollTarget(-40, 1000, 500);
        expect(r.target).toBe(0);
        expect(r.clamped).toBe(true);
    });

    test('in-range target not clamped', () => {
        const r = clampScrollTarget(300, 1000, 500);
        expect(r.target).toBe(300);
        expect(r.clamped).toBe(false);
    });

    test('reverse drag after clamp resumes: same anchor key, delta recomputed from the last committed frame', () => {
        // Clamped at max: scrollTop 500 (max), anchor doc top 310.
        const tx = makeTx(frame('c', 310, [['a', 0, 110], ['b', 1, 200], ['c', 2, 150]]));
        // Content shrinks (reverse drag): anchor top 310 -> 300, delta -10.
        const next = frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150]]);
        const delta = computeAnchorDelta(next, tx.previousLayout);
        expect(delta).toBe(-10);
        expect(computeTargetScrollTop(500, delta)).toBe(490);
        expect(tx.anchorKey).toBe('c'); // same key kept; state flips back to active
    });
});

describe('conversationResizeLayout diffMountedRows', () => {
    test('reports only keys with real height change > 0.5px', () => {
        const tx = makeTx(frame('c', 300, [['a', 0, 100], ['b', 1, 200], ['c', 2, 150]]));
        const next = frame('c', 300, [['a', 0, 100], ['b', 1, 201], ['c', 2, 150]]);
        expect(diffMountedRows(tx.previousLayout, next)).toEqual(['b']);
    });

    test('newly mounted rows count as changed', () => {
        const tx = makeTx(frame('c', 300, [['a', 0, 100]]));
        const next = frame('c', 300, [['a', 0, 100], ['b', 1, 250]]);
        expect(diffMountedRows(tx.previousLayout, next)).toEqual(['b']);
    });
});

describe('conversationResizeLayout held range', () => {
    test('initial range = union of mounted indexes and the anchor window', () => {
        // mounted [10..14], anchor window [11..13] -> union [10..14]
        // (covers anchorIndex-1 = 11 = previous assistant).
        const held = initHeldRange([10, 11, 12, 13, 14], 12);
        expect(held.start).toBe(10);
        expect(held.end).toBe(14);
    });

    test('anchor without mounted window keeps the anchor window', () => {
        const held = initHeldRange([], 5);
        expect(held.start).toBe(4);
        expect(held.end).toBe(6);
    });

    test('monotonic extension: start never grows, end never shrinks', () => {
        let held = { start: 9, end: 15 };
        held = extendHeldRange(held, 12, 18, 40);
        expect(held).toEqual({ start: 9, end: 18 });
        held = extendHeldRange(held, 4, 10, 40);
        expect(held).toEqual({ start: 4, end: 18 });
        held = extendHeldRange(held, 20, 30, 40);
        expect(held).toEqual({ start: 4, end: 30 });
    });

    test('clamps to [0, count-1]', () => {
        expect(extendHeldRange({ start: -2, end: 12 }, 0, 2, 10)).toEqual({ start: 0, end: 9 });
    });
});
