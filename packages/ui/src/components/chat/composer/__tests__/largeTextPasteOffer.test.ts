import { describe, expect, test } from 'bun:test';

import {
    beginLargeTextPasteOffer,
    resolveLargeTextPasteOffer,
} from '../largeTextPasteOffer';

describe('large text paste offer state', () => {
    const defaultChoice = { explicitlyChosen: false };
    test('begin allocates the next offer id', () => {
        expect(beginLargeTextPasteOffer(0)).toBe(1);
        expect(beginLargeTextPasteOffer(3)).toBe(4);
    });

    test('resolve accepts a matching active offer and invalidates it', () => {
        expect(resolveLargeTextPasteOffer(2, 2, defaultChoice)).toEqual({
            accepted: true,
            nextOfferId: 3,
            restoreFocus: false,
        });
    });

    test('resolve rejects a superseded offer without advancing', () => {
        expect(resolveLargeTextPasteOffer(5, 4, defaultChoice)).toEqual({
            accepted: false,
            nextOfferId: 5,
            restoreFocus: false,
        });
    });

    test('second resolve after accept is rejected (double-apply guard)', () => {
        const first = resolveLargeTextPasteOffer(1, 1, defaultChoice);
        expect(first.accepted).toBe(true);
        expect(resolveLargeTextPasteOffer(first.nextOfferId, 1, defaultChoice)).toEqual({
            accepted: false,
            nextOfferId: first.nextOfferId,
            restoreFocus: false,
        });
    });

    test('begin then resolve of the old id is rejected', () => {
        const previous = 2;
        const next = beginLargeTextPasteOffer(previous);
        expect(resolveLargeTextPasteOffer(next, previous, defaultChoice)).toEqual({
            accepted: false,
            nextOfferId: next,
            restoreFocus: false,
        });
        expect(resolveLargeTextPasteOffer(next, next, defaultChoice).accepted).toBe(true);
    });

    test('only an explicit choice on an active offer restores focus', () => {
        expect(resolveLargeTextPasteOffer(1, 1, { explicitlyChosen: true }).restoreFocus).toBe(true);
        expect(resolveLargeTextPasteOffer(2, 1, { explicitlyChosen: true }).restoreFocus).toBe(false);
        expect(resolveLargeTextPasteOffer(1, 1, { explicitlyChosen: false }).restoreFocus).toBe(false);
    });
});
