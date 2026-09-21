import { describe, expect, test } from 'bun:test';

import { createScrollSpy } from './scrollSpy';

describe('createScrollSpy', () => {
    test('activates the final turn throughout the chat bottom spacer', () => {
        const frames: FrameRequestCallback[] = [];
        const activeTurnIds: string[] = [];
        const spy = createScrollSpy({
            onActive: (turnId) => activeTurnIds.push(turnId),
            raf: (callback) => {
                frames.push(callback);
                return frames.length;
            },
            caf: () => {},
        });
        const container = {
            scrollHeight: 1_000,
            scrollTop: 870,
            clientHeight: 100,
            getBoundingClientRect: () => ({ top: 0 }),
        } as HTMLDivElement;
        const previousTurn = {
            getBoundingClientRect: () => ({ top: -120 }),
        } as HTMLElement;
        const finalTurn = {
            // Its top is still below the reading line at this scroll position.
            getBoundingClientRect: () => ({ top: 120 }),
        } as HTMLElement;

        spy.setContainer(container);
        spy.register(previousTurn, 'previous');
        spy.register(finalTurn, 'final');
        while (frames.length > 0) {
            frames.shift()?.(0);
        }

        expect(activeTurnIds).toEqual(['final']);
    });
});
