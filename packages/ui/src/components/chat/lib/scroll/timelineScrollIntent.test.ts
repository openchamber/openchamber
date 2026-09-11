import { describe, expect, test } from 'bun:test';

import { isFollowReleaseKey, isMiddleButtonPan, nestedScrollableConsumesWheelUp } from './timelineScrollIntent';

const key = (
    k: string,
    modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });

describe('isFollowReleaseKey', () => {
    test('upward navigation keys release follow', () => {
        for (const k of ['ArrowUp', 'PageUp', 'Home']) expect(isFollowReleaseKey(key(k))).toBe(true);
        expect(isFollowReleaseKey(key(' ', { shiftKey: true }))).toBe(true);
    });

    test('downward keys, plain space, and modified shortcuts do not', () => {
        for (const k of ['ArrowDown', 'PageDown', 'End', ' ', 'Pause', 'Enter']) {
            expect(isFollowReleaseKey(key(k))).toBe(false);
        }
        expect(isFollowReleaseKey(key('Home', { ctrlKey: true }))).toBe(false);
        expect(isFollowReleaseKey(key('ArrowUp', { metaKey: true }))).toBe(false);
        expect(isFollowReleaseKey(key('ArrowUp', { altKey: true }))).toBe(false);
    });
});

// The helpers only use Element#closest, scrollTop, and identity, so a minimal
// DOM stand-in built on EventTarget is enough — no renderer or jsdom.
class FakeElement extends EventTarget {
    scrollTop = 0;
    constructor(private readonly scrollable: boolean, private readonly parent: FakeElement | null = null) {
        super();
    }
    closest(selector: string): FakeElement | null {
        if (selector !== '[data-scrollable]') throw new Error(`unexpected selector ${selector}`);
        if (this.scrollable) return this;
        return this.parent?.closest(selector) ?? null;
    }
}
// SAFETY: the helpers narrow with `instanceof Element` / `instanceof HTMLElement`;
// registering the fakes under those globals keeps the narrowing honest in bun.
const installDomGlobals = () => {
    const previous = { Element: globalThis.Element, HTMLElement: globalThis.HTMLElement };
    Object.assign(globalThis, { Element: FakeElement, HTMLElement: FakeElement });
    return () => Object.assign(globalThis, previous);
};
// With the globals above installed, FakeElement IS the HTMLElement the helpers
// narrow to; reading it back through the global bridges the static type without
// asserting anything the runtime does not hold.
const asRoot = (element: FakeElement): HTMLElement => {
    if (!(element instanceof globalThis.HTMLElement)) throw new Error('DOM globals not installed');
    return element;
};

describe('nested scroller handling', () => {
    test('an upward wheel over a nested scroller with room above stays there', () => {
        const restore = installDomGlobals();
        try {
            const root = new FakeElement(false);
            const box = new FakeElement(true, root);
            const inner = new FakeElement(false, box);
            box.scrollTop = 40;
            expect(nestedScrollableConsumesWheelUp(asRoot(root), inner)).toBe(true);
            box.scrollTop = 0;
            expect(nestedScrollableConsumesWheelUp(asRoot(root), inner)).toBe(false);
            expect(nestedScrollableConsumesWheelUp(asRoot(root), new FakeElement(false, root))).toBe(false);
        } finally {
            restore();
        }
    });

    test('a middle-button press pans the timeline unless it lands in a nested scroller', () => {
        const restore = installDomGlobals();
        try {
            const root = new FakeElement(false);
            const row = new FakeElement(false, root);
            const box = new FakeElement(true, root);
            expect(isMiddleButtonPan(asRoot(root), { button: 1, target: row })).toBe(true);
            expect(isMiddleButtonPan(asRoot(root), { button: 1, target: box })).toBe(false);
            expect(isMiddleButtonPan(asRoot(root), { button: 0, target: row })).toBe(false);
        } finally {
            restore();
        }
    });
});
