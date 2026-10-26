import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { createScrollSpy } from './scrollSpy';

const originalGlobals = {
    document: globalThis.document,
    DOMRect: globalThis.DOMRect,
};

const createHarness = (scroll: { scrollHeight: number; scrollTop: number; clientHeight: number }) => {
    const frames: FrameRequestCallback[] = [];
    const activeTurnIds: string[] = [];
    const container = document.createElement('div');
    Object.defineProperties(container, {
        scrollHeight: { value: scroll.scrollHeight },
        clientHeight: { value: scroll.clientHeight },
    });
    container.scrollTop = scroll.scrollTop;
    container.getBoundingClientRect = () => new DOMRect();
    const spy = createScrollSpy({
        onActive: (turnId) => activeTurnIds.push(turnId),
        raf: (callback) => {
            frames.push(callback);
            return frames.length;
        },
        caf: () => {},
    });

    return {
        container,
        spy,
        activeTurnIds,
        drainFrames: () => {
            while (frames.length > 0) {
                frames.shift()?.(0);
            }
        },
    };
};

/** A turn whose top edge sits this many pixels below the container's top. */
const turnAt = (viewportTop: number): HTMLElement => {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => new DOMRect(0, viewportTop);
    return element;
};

describe('createScrollSpy', () => {
    beforeEach(() => {
        const windowInstance = new Window();
        Object.assign(globalThis, {
            document: windowInstance.document,
            DOMRect: windowInstance.DOMRect,
        });
    });

    afterEach(() => {
        Object.assign(globalThis, originalGlobals);
    });

    test('activates the final turn throughout the chat bottom spacer', () => {
        const { container, spy, activeTurnIds, drainFrames } = createHarness({
            scrollHeight: 1_000,
            scrollTop: 870,
            clientHeight: 100,
        });

        spy.setContainer(container);
        spy.register(turnAt(-120), 'previous');
        // Its top is still below the reading line at this scroll position.
        spy.register(turnAt(120), 'final');
        drainFrames();

        expect(activeTurnIds).toEqual(['final']);
    });

    test('follows the turn that owns most of the viewport, not a sliver of the one above', () => {
        const { container, spy, activeTurnIds, drainFrames } = createHarness({
            scrollHeight: 5_000,
            scrollTop: 1_000,
            clientHeight: 800,
        });

        spy.setContainer(container);
        // The turn above shows only its tail in the top 120px of the viewport;
        // the turn below owns the rest of it.
        spy.register(turnAt(-500), 'previous');
        spy.register(turnAt(120), 'next');
        drainFrames();

        expect(activeTurnIds).toEqual(['next']);
    });

    test('holds the active turn while scrolling inside it', () => {
        const { container, spy, activeTurnIds, drainFrames } = createHarness({
            scrollHeight: 8_000,
            scrollTop: 2_000,
            clientHeight: 600,
        });

        spy.setContainer(container);
        spy.register(turnAt(-2_000), 'first');
        spy.register(turnAt(900), 'second');
        drainFrames();

        // Both positions still put the reading line inside the first turn.
        container.scrollTop = 2_400;
        spy.onScroll();
        drainFrames();

        container.scrollTop = 2_700;
        spy.onScroll();
        drainFrames();

        expect(activeTurnIds).toEqual(['first', 'second']);
    });

    test('starts on the first turn at the top of the transcript', () => {
        const { container, spy, activeTurnIds, drainFrames } = createHarness({
            scrollHeight: 3_000,
            scrollTop: 0,
            clientHeight: 600,
        });

        spy.setContainer(container);
        spy.register(turnAt(0), 'first');
        spy.register(turnAt(1_500), 'second');
        drainFrames();

        expect(activeTurnIds).toEqual(['first']);
    });
});
