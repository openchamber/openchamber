import { describe, expect, test } from 'bun:test';

import {
    LARGE_TEXT_PASTE_TOAST_CLASSNAME,
    beginLargeTextPasteOffer,
    resolveLargeTextPasteOffer,
} from '../largeTextPasteOffer';

describe('large text paste offer state', () => {
    test('begin allocates the next offer id', () => {
        expect(beginLargeTextPasteOffer(0)).toBe(1);
        expect(beginLargeTextPasteOffer(3)).toBe(4);
    });

    test('resolve accepts a matching active offer and invalidates it', () => {
        expect(resolveLargeTextPasteOffer(2, 2)).toEqual({
            accepted: true,
            nextOfferId: 3,
        });
    });

    test('resolve rejects a superseded offer without advancing', () => {
        expect(resolveLargeTextPasteOffer(5, 4)).toEqual({
            accepted: false,
            nextOfferId: 5,
        });
    });

    test('second resolve after accept is rejected (double-apply guard)', () => {
        const first = resolveLargeTextPasteOffer(1, 1);
        expect(first.accepted).toBe(true);
        expect(resolveLargeTextPasteOffer(first.nextOfferId, 1)).toEqual({
            accepted: false,
            nextOfferId: first.nextOfferId,
        });
    });

    test('begin then resolve of the old id is rejected', () => {
        const previous = 2;
        const next = beginLargeTextPasteOffer(previous);
        expect(resolveLargeTextPasteOffer(next, previous)).toEqual({
            accepted: false,
            nextOfferId: next,
        });
        expect(resolveLargeTextPasteOffer(next, next).accepted).toBe(true);
    });

    test('toast class widens only from the sm breakpoint', () => {
        const classes = LARGE_TEXT_PASTE_TOAST_CLASSNAME.split(/\s+/);
        expect(classes).toContain('sm:!min-w-[22rem]');
        expect(classes).toContain('sm:!w-auto');
        expect(classes).toContain('[&_[data-icon]]:!hidden');
        expect(classes.includes('!min-w-[22rem]')).toBe(false);
        expect(classes.includes('!w-auto')).toBe(false);
    });
});
