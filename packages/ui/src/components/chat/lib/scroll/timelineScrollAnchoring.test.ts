import { describe, expect, test } from 'bun:test';

import {
    getRowBottom,
    resolveRealContentEndOffset,
    resolveTimelineIsAtEnd,
    type TimelineListMeasurementState,
} from './timelineScrollAnchoring';

const buildState = ({
    positions,
    sizes,
    scroll = 0,
    scrollLength = 700,
}: {
    readonly positions: readonly number[];
    readonly sizes: readonly number[];
    readonly scroll?: number;
    readonly scrollLength?: number;
}): TimelineListMeasurementState => ({
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index) => positions[index],
    sizeAtIndex: (index) => sizes[index],
});

describe('getRowBottom', () => {
    test('measures row bottoms from list row position and size', () => {
        const state = buildState({ positions: [0, 120], sizes: [80, 40] });

        expect(getRowBottom(state, 1)).toBe(160);
    });

    test('returns null for unmeasured rows', () => {
        const state = buildState({ positions: [0], sizes: [80] });

        expect(getRowBottom(state, 5)).toBeNull();
    });

    test('treats a zero-height row as one pixel tall', () => {
        const state = buildState({ positions: [0, 120], sizes: [120, 0] });

        expect(getRowBottom(state, 1)).toBe(121);
    });
});

describe('resolveRealContentEndOffset', () => {
    test('puts the last row bottom just above the composer overlay', () => {
        const state = buildState({
            positions: [0, 1000],
            sizes: [1000, 200],
            scroll: 0,
            scrollLength: 700,
        });

        expect(resolveRealContentEndOffset({ state, composerOverlayHeight: 180 })).toBe(680);
    });

    test('ignores content length inflated by reserved end space or stale sizes', () => {
        // The list still reports a far larger content length than the measured
        // rows; the end offset must follow the rows, not that length.
        const state = buildState({
            positions: [0, 300],
            sizes: [300, 100],
            scroll: 900,
            scrollLength: 700,
        });

        expect(resolveRealContentEndOffset({ state, composerOverlayHeight: 180 })).toBe(0);
    });

    test('counts the footer rendered after the last row as real content', () => {
        const state = buildState({
            positions: [0, 1000],
            sizes: [1000, 200],
            scrollLength: 700,
        });

        expect(resolveRealContentEndOffset({ state, composerOverlayHeight: 180, footerSize: 120 })).toBe(800);
    });

    test('returns null for an empty timeline and for unmeasured last rows', () => {
        expect(resolveRealContentEndOffset({
            state: buildState({ positions: [], sizes: [] }),
            composerOverlayHeight: 180,
        })).toBeNull();

        expect(resolveRealContentEndOffset({
            state: buildState({ positions: [0, 100], sizes: [100] }),
            composerOverlayHeight: 180,
        })).toBeNull();
    });
});

describe('resolveTimelineIsAtEnd', () => {
    test('uses a 40px band regardless of viewport height', () => {
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1400, scrollLength: 600 })).toBe(true);
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1360, scrollLength: 600 })).toBe(true);
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1359, scrollLength: 600 })).toBe(false);
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1100, scrollLength: 600 })).toBe(false);
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1900, scrollLength: 60 })).toBe(true);
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1899, scrollLength: 60 })).toBe(false);
    });

    test('falls back to the list flags when distances are unavailable', () => {
        expect(resolveTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(true);
        expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    });

    test('reports nothing without a state', () => {
        expect(resolveTimelineIsAtEnd(undefined)).toBe(undefined);
    });
});
