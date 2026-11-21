import { describe, expect, test } from 'bun:test';

import { foldContextRows } from './contextRowFold';

const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));

describe('foldContextRows', () => {
    test('keeps every row visible while the list fits', () => {
        const fold = foldContextRows(rowsOf(3), { limit: 4, showAll: false, keepId: null });
        expect(fold.visible.map((row) => row.id)).toEqual(['row-0', 'row-1', 'row-2']);
        expect(fold.hiddenCount).toBe(0);
    });

    test('folds the rest behind the count', () => {
        const fold = foldContextRows(rowsOf(6), { limit: 4, showAll: false, keepId: null });
        expect(fold.visible.map((row) => row.id)).toEqual(['row-0', 'row-1', 'row-2', 'row-3']);
        expect(fold.hiddenCount).toBe(2);
    });

    test('keeps a folded kept row on screen, up to the limit', () => {
        const fold = foldContextRows(rowsOf(6), { limit: 4, showAll: false, keepId: 'row-5' });
        expect(fold.visible.map((row) => row.id)).toEqual(['row-0', 'row-1', 'row-2', 'row-5']);
        expect(fold.hiddenCount).toBe(2);
    });

    test('leaves the visible rows alone when the kept row is already among them', () => {
        const fold = foldContextRows(rowsOf(6), { limit: 4, showAll: false, keepId: 'row-1' });
        expect(fold.visible.map((row) => row.id)).toEqual(['row-0', 'row-1', 'row-2', 'row-3']);
        expect(fold.hiddenCount).toBe(2);
    });

    test('shows everything when the list is unfolded', () => {
        const fold = foldContextRows(rowsOf(6), { limit: 4, showAll: true, keepId: 'row-5' });
        expect(fold.visible).toHaveLength(6);
        expect(fold.hiddenCount).toBe(0);
    });
});
