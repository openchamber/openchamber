import { describe, expect, test } from 'bun:test';

import { KEYBOARD_EASING_CSS, createCubicBezierEasing, keyboardEase } from './mobileKeyboardTiming';

const expectClose = (actual: number, expected: number, tolerance: number) => {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

describe('createCubicBezierEasing', () => {
    test('linear control points reproduce the identity', () => {
        const linear = createCubicBezierEasing(0, 0, 1, 1);
        for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
            expectClose(linear(t), t, 1e-4);
        }
    });

    test('ease-in-out matches known CSS samples', () => {
        // cubic-bezier(0.42, 0, 0.58, 1) — CSS `ease-in-out`.
        const easeInOut = createCubicBezierEasing(0.42, 0, 0.58, 1);
        expectClose(easeInOut(0.5), 0.5, 1e-3);
        expectClose(easeInOut(0.25), 0.129, 5e-3);
        expectClose(easeInOut(0.75), 0.871, 5e-3);
    });

    test('clamps outside the unit interval', () => {
        expect(keyboardEase(-1)).toBe(0);
        expect(keyboardEase(2)).toBe(1);
    });
});

describe('keyboardEase', () => {
    test('is monotonic and decelerating', () => {
        let previous = 0;
        for (let i = 1; i <= 20; i += 1) {
            const value = keyboardEase(i / 20);
            expect(value).toBeGreaterThanOrEqual(previous);
            previous = value;
        }
        // A decelerating curve is past the halfway mark at half time.
        expect(keyboardEase(0.5)).toBeGreaterThan(0.6);
    });

    test('CSS string carries the same control points', () => {
        expect(KEYBOARD_EASING_CSS).toBe('cubic-bezier(0.38, 0.7, 0.125, 1)');
    });
});
