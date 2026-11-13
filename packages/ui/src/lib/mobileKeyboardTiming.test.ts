import { describe, expect, test } from 'bun:test';

import { KEYBOARD_SHOW_MS, keyboardEase, keyboardKeyframes } from './mobileKeyboardTiming';

// The keyboard's position per 60 fps frame from the start of its rise, traced
// from a simulator recording (share of the travel covered).
const RECORDED_KEYBOARD = [0.05, 0.23, 0.37, 0.49, 0.61, 0.71, 0.77, 0.83, 0.87, 0.91, 0.93, 0.95, 0.96, 0.98, 0.98];

describe('keyboardEase', () => {
    test('follows the recorded keyboard within 4% on every frame', () => {
        RECORDED_KEYBOARD.forEach((position, index) => {
            const t = (index + 1) / 60;
            expect(Math.abs(keyboardEase((t * 1000) / KEYBOARD_SHOW_MS) - position)).toBeLessThanOrEqual(0.04);
        });
    });

    test('starts at rest, ends on target, clamps outside the run', () => {
        expect(keyboardEase(-1)).toBe(0);
        expect(keyboardEase(0)).toBe(0);
        expect(keyboardEase(1)).toBe(1);
        expect(keyboardEase(2)).toBe(1);
    });
});

// Core Animation runs keyframes joined by plain linear segments; a keyframe
// carrying its own easing (a linear() one above all) sends the whole
// animation back to the main thread on iOS WebKit.
describe('keyboardKeyframes', () => {
    const frames = keyboardKeyframes((position) => ({ transform: `translateY(${position * 100}px)` }));

    test('traces the curve from start to target with no easing of their own', () => {
        expect(frames[0]).toEqual({ transform: 'translateY(0px)', offset: 0 });
        expect(frames[frames.length - 1]).toEqual({ transform: 'translateY(100px)', offset: 1 });
        for (const frame of frames) expect(frame.easing).toBeUndefined();
    });

    test('offsets rise evenly and positions follow keyboardEase', () => {
        frames.forEach((frame, index) => {
            const offset = index / (frames.length - 1);
            expect(frame.offset).toBe(offset);
            expect(frame.transform).toBe(`translateY(${keyboardEase(offset) * 100}px)`);
        });
    });
});
