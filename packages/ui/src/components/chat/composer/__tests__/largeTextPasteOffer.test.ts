import { describe, expect, test } from 'bun:test';

import {
    LARGE_TEXT_PASTE_TOAST_CLASSNAME,
    beginLargeTextPasteOffer,
    resolveLargeTextPasteOffer,
} from '../largeTextPasteOffer';

describe('large text paste offer state', () => {
    const desktopChoice = { isMobile: false, explicitlyChosen: true };
    test('begin allocates the next offer id', () => {
        expect(beginLargeTextPasteOffer(0)).toBe(1);
        expect(beginLargeTextPasteOffer(3)).toBe(4);
    });

    test('resolve accepts a matching active offer and invalidates it', () => {
        expect(resolveLargeTextPasteOffer(2, 2, desktopChoice)).toEqual({
            accepted: true,
            nextOfferId: 3,
            restoreFocus: false,
        });
    });

    test('resolve rejects a superseded offer without advancing', () => {
        expect(resolveLargeTextPasteOffer(5, 4, desktopChoice)).toEqual({
            accepted: false,
            nextOfferId: 5,
            restoreFocus: false,
        });
    });

    test('second resolve after accept is rejected (double-apply guard)', () => {
        const first = resolveLargeTextPasteOffer(1, 1, desktopChoice);
        expect(first.accepted).toBe(true);
        expect(resolveLargeTextPasteOffer(first.nextOfferId, 1, desktopChoice)).toEqual({
            accepted: false,
            nextOfferId: first.nextOfferId,
            restoreFocus: false,
        });
    });

    test('begin then resolve of the old id is rejected', () => {
        const previous = 2;
        const next = beginLargeTextPasteOffer(previous);
        expect(resolveLargeTextPasteOffer(next, previous, desktopChoice)).toEqual({
            accepted: false,
            nextOfferId: next,
            restoreFocus: false,
        });
        expect(resolveLargeTextPasteOffer(next, next, desktopChoice).accepted).toBe(true);
    });

    test('only an explicit mobile choice on an active offer restores focus', () => {
        const mobileChoice = { isMobile: true, explicitlyChosen: true };
        expect(resolveLargeTextPasteOffer(1, 1, mobileChoice).restoreFocus).toBe(true);
        expect(resolveLargeTextPasteOffer(2, 1, mobileChoice).restoreFocus).toBe(false);
        expect(resolveLargeTextPasteOffer(1, 1, { isMobile: false, explicitlyChosen: true }).restoreFocus).toBe(false);
        expect(resolveLargeTextPasteOffer(1, 1, { isMobile: true, explicitlyChosen: false }).restoreFocus).toBe(false);
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
