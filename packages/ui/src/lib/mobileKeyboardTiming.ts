/**
 * The iOS keyboard's motion, as one shared timing.
 *
 * `useNativeMobileChrome` slides the composer with it, tweens the chat
 * scroller's keyboard inset with it, and the pill ↔ composer morph grows and
 * shrinks with it, so the keyboard, the composer and the transcript read as
 * one movement. The curve mimics UIKit's keyboard animation (≈0.25s, a
 * decelerating cubic); dismissal reads faster than the rise, so the hide leg
 * runs shorter.
 */

export const KEYBOARD_SHOW_MS = 250;
export const KEYBOARD_HIDE_MS = 200;

const KEYBOARD_BEZIER: readonly [number, number, number, number] = [0.38, 0.7, 0.125, 1];

export const KEYBOARD_EASING_CSS = `cubic-bezier(${KEYBOARD_BEZIER.join(', ')})`;

/**
 * Evaluate a CSS `cubic-bezier(x1, y1, x2, y2)` timing function at progress
 * `t` (0..1): solve the x curve for the parameter, then read y. Used to drive
 * a value from JavaScript on the same curve a CSS transition follows.
 */
export const createCubicBezierEasing = (x1: number, y1: number, x2: number, y2: number) => {
    const sampleCurve = (a: number, b: number, param: number) => {
        // Bezier with endpoints 0 and 1: 3(1-p)^2 p a + 3(1-p) p^2 b + p^3.
        const inverse = 1 - param;
        return 3 * inverse * inverse * param * a + 3 * inverse * param * param * b + param * param * param;
    };
    const sampleDerivativeX = (param: number) => {
        const inverse = 1 - param;
        return 3 * inverse * inverse * x1 + 6 * inverse * param * (x2 - x1) + 3 * param * param * (1 - x2);
    };
    const solveParamForX = (x: number) => {
        // Newton–Raphson, then bisection when the slope is too flat.
        let param = x;
        for (let i = 0; i < 8; i += 1) {
            const error = sampleCurve(x1, x2, param) - x;
            if (Math.abs(error) < 1e-5) return param;
            const slope = sampleDerivativeX(param);
            if (Math.abs(slope) < 1e-6) break;
            param -= error / slope;
        }
        let low = 0;
        let high = 1;
        param = x;
        while (high - low > 1e-5) {
            const mid = (low + high) / 2;
            if (sampleCurve(x1, x2, mid) < x) low = mid;
            else high = mid;
            param = mid;
        }
        return param;
    };
    return (t: number): number => {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return sampleCurve(y1, y2, solveParamForX(t));
    };
};

/** Progress (0..1) → eased progress on the keyboard curve. */
export const keyboardEase = createCubicBezierEasing(...KEYBOARD_BEZIER);
