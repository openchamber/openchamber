import { describe, expect, test } from 'bun:test';

import { resolveComposerTailInset } from './composerTailInset';

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
