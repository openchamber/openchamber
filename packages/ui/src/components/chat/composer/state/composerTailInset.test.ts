import { describe, expect, test } from 'bun:test';

import { recordComposerSlotHeight, resolveComposerTailInset } from './composerTailInset';

describe('resolveComposerTailInset', () => {
    test('a resting composer reserves its height plus the gap', () => {
        expect(resolveComposerTailInset(120, 120)).toBe(200);
    });

    test('growth within the allowance keeps the transcript end in place', () => {
        expect(resolveComposerTailInset(120, 160)).toBe(200);
        expect(resolveComposerTailInset(120, 208)).toBe(200);
    });

    test('growth past the allowance pushes the end by the excess only', () => {
        expect(resolveComposerTailInset(120, 248)).toBe(240);
    });

    test('a pill-to-composer swap moves the end by the inset change, not the slot change', () => {
        const pill = 64;
        const expanded = 260;
        const endShift = resolveComposerTailInset(pill, expanded) - resolveComposerTailInset(pill, pill);
        expect(endShift).toBe(expanded - pill - 88);
    });
});

describe('recordComposerSlotHeight', () => {
    test('a read-only banner in the slot never becomes the resting height', () => {
        // SAFETY: the column is only a WeakMap key here, so any object stands in for it.
        const column = {} as HTMLElement;
        expect(recordComposerSlotHeight(column, 128).grown).toBe(false);
        expect(recordComposerSlotHeight(column, 70, false)).toEqual({ tailInset: 208, grown: false });
        // Back in a session with a composer: it is at rest, not grown.
        expect(recordComposerSlotHeight(column, 128)).toEqual({ tailInset: 208, grown: false });
        expect(recordComposerSlotHeight(column, 180).grown).toBe(true);
    });

    test('a pinned slot taller than the resting composer is grown, without moving the floor', () => {
        // SAFETY: the column is only a WeakMap key here, so any object stands in for it.
        const column = {} as HTMLElement;
        recordComposerSlotHeight(column, 114);
        expect(recordComposerSlotHeight(column, 162, false)).toEqual({ tailInset: 194, grown: true });
        expect(recordComposerSlotHeight(column, 110, false).grown).toBe(false);
        expect(recordComposerSlotHeight(column, 114)).toEqual({ tailInset: 194, grown: false });
    });
});
