import { describe, expect, test } from 'bun:test';

import {
    CHAT_LIST_ANCHOR_OFFSET,
    getAnchoredTurnMetrics,
    getRowBottom,
    resolveChatListAnchoredEndSpace,
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

describe('getAnchoredTurnMetrics', () => {
    test('returns null for an empty timeline', () => {
        const state = buildState({ positions: [], sizes: [] });

        expect(getAnchoredTurnMetrics({
            state,
            anchorIndex: 0,
            composerOverlayHeight: 180,
            anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
        })).toBeNull();
    });

    test('treats the active turn as fitting when it fits above the composer', () => {
        const state = buildState({
            positions: [0, 300, 460],
            sizes: [240, 80, 140],
            scrollLength: 760,
        });

        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 1,
            composerOverlayHeight: 180,
            anchorOffset: 16,
        });

        expect(metrics?.turnHeight).toBe(300);
        expect(metrics?.usableViewportHeight).toBe(564);
        expect(metrics?.overflowsUsableViewport).toBe(false);
        expect(metrics?.targetScrollToRevealEnd).toBe(36);
        expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
    });

    test('targets the real row end instead of any temporary reserved tail', () => {
        const state = buildState({
            positions: [0, 1720, 1880],
            sizes: [1600, 80, 120],
            scroll: 1900,
            scrollLength: 760,
        });

        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 1,
            composerOverlayHeight: 180,
            anchorOffset: 16,
        });

        expect(metrics?.lastBottom).toBe(2000);
        expect(metrics?.targetScrollToRevealEnd).toBe(1436);
        expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
    });

    test('reports overflow only for the current anchored turn', () => {
        const state = buildState({
            positions: [0, 900, 1180],
            sizes: [800, 220, 300],
            scroll: 900,
            scrollLength: 760,
        });

        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 1,
            composerOverlayHeight: 180,
            anchorOffset: 16,
        });

        expect(metrics?.turnHeight).toBe(580);
        expect(metrics?.usableViewportHeight).toBe(564);
        expect(metrics?.overflowsUsableViewport).toBe(true);
    });

    test('returns the minimal positive scroll delta needed to reveal the turn end', () => {
        const state = buildState({
            positions: [0, 900, 1180],
            sizes: [800, 220, 360],
            scroll: 900,
            scrollLength: 760,
        });

        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 1,
            composerOverlayHeight: 180,
            anchorOffset: 16,
        });

        expect(metrics?.lastBottom).toBe(1540);
        expect(metrics?.visibleUsableBottom).toBe(1464);
        expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
    });

    test('subtracts composer height from usable viewport height', () => {
        const state = buildState({
            positions: [0, 300],
            sizes: [120, 470],
            scrollLength: 700,
        });

        const withoutComposer = getAnchoredTurnMetrics({
            state,
            anchorIndex: 1,
            composerOverlayHeight: 0,
            anchorOffset: 16,
        });
        const withComposer = getAnchoredTurnMetrics({
            state,
            anchorIndex: 1,
            composerOverlayHeight: 220,
            anchorOffset: 16,
        });

        expect(withoutComposer?.overflowsUsableViewport).toBe(false);
        expect(withComposer?.overflowsUsableViewport).toBe(true);
    });

    test('clamps an out-of-range anchor index to the last row', () => {
        const state = buildState({
            positions: [0, 300],
            sizes: [240, 80],
            scrollLength: 760,
        });

        const metrics = getAnchoredTurnMetrics({
            state,
            anchorIndex: 99,
            composerOverlayHeight: 0,
            anchorOffset: 16,
        });

        expect(metrics?.anchorTop).toBe(300);
        expect(metrics?.turnHeight).toBe(80);
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

    test('reserves extra slack below the content when asked', () => {
        const state = buildState({
            positions: [0, 1000],
            sizes: [1000, 200],
            scrollLength: 700,
        });

        expect(resolveRealContentEndOffset({
            state,
            composerOverlayHeight: 180,
            extraInset: CHAT_LIST_ANCHOR_OFFSET,
        })).toBe(696);
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
    test('uses a tight distance band against the full content length', () => {
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1400, scrollLength: 600 })).toBe(true);
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1365, scrollLength: 600 })).toBe(true);
        expect(resolveTimelineIsAtEnd({ contentLength: 2000, scroll: 1300, scrollLength: 600 })).toBe(false);
    });

    test('falls back to the list flags when distances are unavailable', () => {
        expect(resolveTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(true);
        expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    });

    test('reports nothing without a state', () => {
        expect(resolveTimelineIsAtEnd(undefined)).toBe(undefined);
    });
});

describe('resolveChatListAnchoredEndSpace', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'a' }];

    test('returns nothing when no anchor is set', () => {
        expect(resolveChatListAnchoredEndSpace(rows, null, (row) => row.id)).toBe(undefined);
    });

    test('returns nothing when the anchor is not in the list', () => {
        expect(resolveChatListAnchoredEndSpace(rows, 'z', (row) => row.id)).toBe(undefined);
    });

    test('resolves the last occurrence so a resent message anchors to its live row', () => {
        expect(resolveChatListAnchoredEndSpace(rows, 'a', (row) => row.id)).toEqual({
            anchorIndex: 2,
            anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
        });
    });

    test('honours an explicit anchor offset', () => {
        expect(resolveChatListAnchoredEndSpace(rows, 'b', (row) => row.id, { anchorOffset: 40 })).toEqual({
            anchorIndex: 1,
            anchorOffset: 40,
        });
    });
});
