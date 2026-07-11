import { describe, expect, test } from 'bun:test';

import {
    createInitialMarkdownHydratedKeys,
    ensureNewestMarkdownKeyHydrated,
    getMarkdownHydrationCandidates,
    pruneMarkdownHydratedKeys,
} from './markdownHydrationWindow';

const keys = (count: number): string[] => Array.from({ length: count }, (_, index) => `turn-${index}`);

describe('markdown hydration window', () => {
    test('starts with only the newest stable entry key hydrated', () => {
        expect([...createInitialMarkdownHydratedKeys(keys(100))]).toEqual(['turn-99']);
        expect(createInitialMarkdownHydratedKeys([]).size).toBe(0);
    });

    test('keeps a newly completed newest entry hydrated without waiting for scroll', () => {
        const hydrated = new Set(['turn-0']);
        const next = ensureNewestMarkdownKeyHydrated(hydrated, keys(2));
        expect([...next]).toEqual(['turn-0', 'turn-1']);
        expect(ensureNewestMarkdownKeyHydrated(next, keys(2))).toBe(next);
    });

    test('orders visible candidates from newest to oldest', () => {
        const candidates = getMarkdownHydrationCandidates({
            entryKeys: keys(100),
            mountedIndexes: [92, 93, 94, 95, 96, 97, 98, 99],
            visibleStartIndex: 94,
            visibleEndIndex: 99,
            scrollDirection: null,
            preloadEntries: 3,
            hydratedKeys: new Set(['turn-99']),
        });

        expect(candidates).toEqual(['turn-98', 'turn-97', 'turn-96', 'turn-95', 'turn-94']);
    });

    test('preloads only the nearest mounted entries above an upward-moving viewport', () => {
        const candidates = getMarkdownHydrationCandidates({
            entryKeys: keys(100),
            mountedIndexes: [89, 90, 91, 92, 93, 94, 95],
            visibleStartIndex: 92,
            visibleEndIndex: 95,
            scrollDirection: 'backward',
            preloadEntries: 3,
            hydratedKeys: new Set(['turn-92', 'turn-93', 'turn-94', 'turn-95']),
        });

        expect(candidates).toEqual(['turn-91', 'turn-90', 'turn-89']);
    });

    test('does not preload older rows while moving forward', () => {
        const candidates = getMarkdownHydrationCandidates({
            entryKeys: keys(100),
            mountedIndexes: [89, 90, 91, 92, 93, 94, 95],
            visibleStartIndex: 92,
            visibleEndIndex: 95,
            scrollDirection: 'forward',
            preloadEntries: 3,
            hydratedKeys: new Set(['turn-92', 'turn-93', 'turn-94', 'turn-95']),
        });

        expect(candidates).toEqual([]);
    });

    test('a far jump hydrates the new viewport without filling intermediate history', () => {
        const candidates = getMarkdownHydrationCandidates({
            entryKeys: keys(100),
            mountedIndexes: [27, 28, 29, 30, 31, 32, 33, 34, 35],
            visibleStartIndex: 30,
            visibleEndIndex: 35,
            scrollDirection: 'backward',
            preloadEntries: 3,
            hydratedKeys: new Set(['turn-99']),
        });

        expect(candidates).toEqual([
            'turn-35', 'turn-34', 'turn-33', 'turn-32', 'turn-31', 'turn-30',
            'turn-29', 'turn-28', 'turn-27',
        ]);
        expect(candidates).not.toContain('turn-80');
    });

    test('stable hydrated keys survive prepends and removed keys are pruned', () => {
        const hydrated = new Set(['turn-a', 'turn-b']);
        const prepended = ['turn-old', 'turn-a', 'turn-b'];

        expect(pruneMarkdownHydratedKeys(hydrated, prepended)).toBe(hydrated);
        expect([...pruneMarkdownHydratedKeys(hydrated, ['turn-b'])])
            .toEqual(['turn-b']);
    });
});
