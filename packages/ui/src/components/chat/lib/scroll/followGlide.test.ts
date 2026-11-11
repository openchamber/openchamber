import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { createFollowGlide } from './followGlide';

const dom = new Window();

const FRAME_MS = 1000 / 60;

// A scroll node that keeps scrollTop inside [0, max], as a browser does.
const createStand = (max = 10_000) => {
    let top = 0;
    const node = dom.document.createElement('div');
    Object.defineProperty(node, 'scrollTop', {
        get: () => top,
        set: (value: number) => { top = Math.min(max, Math.max(0, value)); },
    });
    let pending: FrameRequestCallback | null = null;
    let time = 0;
    const events = { settled: 0, interrupted: 0 };
    let proceed = true;
    const glide = createFollowGlide({
        node,
        shouldContinue: () => proceed,
        onSettle: () => { events.settled += 1; },
        onInterrupt: () => { events.interrupted += 1; },
        requestFrame: (callback) => { pending = callback; return 1; },
        cancelFrame: () => { pending = null; },
        now: () => time,
    });
    // Runs one frame and returns how far the viewport moved in it.
    const frame = () => {
        const before = top;
        const callback = pending;
        pending = null;
        time += FRAME_MS;
        callback?.(time);
        return top - before;
    };
    return {
        glide,
        node,
        events,
        frame,
        running: () => pending !== null,
        halt: () => { proceed = false; },
    };
};

describe('createFollowGlide', () => {
    test('settles exactly on the target and reports it', () => {
        const stand = createStand();
        stand.glide.aim(300, 300, false);
        let frames = 0;
        while (stand.running() && frames < 200) { stand.frame(); frames += 1; }
        expect(stand.node.scrollTop).toBe(300);
        expect(stand.events.settled).toBe(1);
        // A one-screen-ish step takes a good half second, not a flick.
        expect(frames).toBeGreaterThan(25);
        expect(frames).toBeLessThan(60);
    });

    test('a new target keeps the speed it has', () => {
        const stand = createStand();
        stand.glide.aim(100, 100, false);
        for (let i = 0; i < 8; i++) stand.frame();
        const before = stand.frame();
        expect(before).toBeGreaterThan(0);
        // The next block lands: the glide carries on instead of starting from rest.
        stand.glide.aim(300, 300, false);
        const after = stand.frame();
        expect(after).toBeGreaterThanOrEqual(before);
        expect(stand.events.settled).toBe(0);
    });

    test('moves the whole way without stopping between targets', () => {
        const stand = createStand();
        stand.glide.aim(60, 60, false);
        const steps: number[] = [];
        for (let block = 1; block <= 6; block++) {
            // A block every 400 ms, 60 px each.
            for (let i = 0; i < 24; i++) steps.push(stand.frame());
            stand.glide.aim(60 * (block + 1), 60 * (block + 1), false);
        }
        // After the first few frames of the start, every frame moves.
        expect(steps.slice(3).every((step) => step > 0.1)).toBe(true);
    });

    test('carries on from where something else moved the viewport', () => {
        const stand = createStand();
        stand.glide.aim(400, 400, false);
        for (let i = 0; i < 5; i++) stand.frame();
        stand.node.scrollTop = stand.node.scrollTop + 50;
        const moved = stand.node.scrollTop;
        stand.frame();
        expect(stand.events.interrupted).toBe(1);
        expect(stand.node.scrollTop).toBeGreaterThan(moved);
        expect(stand.glide.isHeadingTo(400, 0)).toBe(false);
        stand.glide.aim(400, 400, false);
        expect(stand.glide.isHeadingTo(400, 0)).toBe(true);
    });

    test('says whether it still heads to the end the list reports', () => {
        const stand = createStand();
        expect(stand.glide.isHeadingTo(400, 0)).toBe(false);
        stand.glide.aim(400, 400, false);
        expect(stand.glide.isHeadingTo(400, 0)).toBe(true);
        expect(stand.glide.isHeadingTo(450, 0)).toBe(false);
    });

    test('stops where it is once it may not continue', () => {
        const stand = createStand();
        stand.glide.aim(400, 400, false);
        for (let i = 0; i < 5; i++) stand.frame();
        const at = stand.node.scrollTop;
        stand.halt();
        stand.frame();
        expect(stand.node.scrollTop).toBe(at);
        expect(stand.running()).toBe(false);
        expect(stand.events.settled).toBe(0);
    });

    test('stops where the content ends short of the target', () => {
        const stand = createStand(250);
        stand.glide.aim(400, 400, false);
        let frames = 0;
        while (stand.running() && frames < 200) { stand.frame(); frames += 1; }
        expect(stand.node.scrollTop).toBe(250);
        expect(stand.events.settled).toBe(1);
    });

    test('leaves the motion to the browser where scrollTop moves in whole pixels', () => {
        let time = 0;
        let settled = 0;
        const calls: ScrollToOptions[] = [];
        const node = dom.document.createElement('div');
        Object.defineProperty(node, 'scrollTop', { value: 1000 });
        Object.defineProperty(node, 'scrollTo', { value: (options: ScrollToOptions) => { calls.push(options); } });
        const glide = createFollowGlide({
            node, native: true, shouldContinue: () => true, onSettle: () => { settled += 1; }, onInterrupt: () => {}, now: () => time,
        });
        expect(glide.isHeadingTo(1400, 1000)).toBe(false);
        glide.aim(1400, 1400, false);
        expect(calls).toEqual([{ top: 1400, behavior: 'smooth' }]);
        // Not moved yet, but only just issued.
        expect(glide.isHeadingTo(1400, 1000)).toBe(true);
        time = 500;
        expect(glide.isHeadingTo(1400, 1100)).toBe(true);
        // The end moved on: aim again.
        expect(glide.isHeadingTo(1450, 1200)).toBe(false);
        // Stopped short where it landed: checked against the true end again.
        expect(glide.isHeadingTo(1400, 1200)).toBe(false);
        node.dispatchEvent(new dom.Event('scrollend'));
        expect(settled).toBe(1);
        glide.stop();
        node.dispatchEvent(new dom.Event('scrollend'));
        expect(settled).toBe(1);
        glide.aim(1400, 1400, false);
        glide.dispose();
        node.dispatchEvent(new dom.Event('scrollend'));
        expect(settled).toBe(1);
    });

    test('jumps to the target when asked for no motion', () => {
        const stand = createStand();
        stand.glide.aim(400, 400, true);
        expect(stand.node.scrollTop).toBe(400);
        expect(stand.running()).toBe(false);
        expect(stand.events.settled).toBe(1);
    });
});
