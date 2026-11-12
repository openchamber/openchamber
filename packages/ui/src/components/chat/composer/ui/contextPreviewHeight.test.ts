import { describe, expect, test } from 'bun:test';
import { getContextPreviewMaxHeight } from './contextPreviewHeight';

describe('getContextPreviewMaxHeight', () => {
    test('keeps a long preview below the chat header when the composer is near the top', () => {
        // The popup has a 6px gap above the chip and 8px clearance from the chat edge.
        expect(getContextPreviewMaxHeight(194, 49, 633)).toBe(131);
    });

    test('retains the existing 50vh / 420px limit when there is room', () => {
        expect(getContextPreviewMaxHeight(600, 49, 700)).toBe(350);
        expect(getContextPreviewMaxHeight(800, 49, 1200)).toBe(420);
    });

    test('does not return a negative height when there is no room above the chip', () => {
        expect(getContextPreviewMaxHeight(50, 49, 633)).toBe(0);
    });
});
