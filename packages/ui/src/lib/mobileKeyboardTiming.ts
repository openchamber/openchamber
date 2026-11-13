import { springCss, springEase, type SpringSpec } from '@/lib/motion/springs';

/**
 * The iOS keyboard's motion, as one shared timing.
 *
 * `useNativeMobileChrome` slides the composer with it, the chat's follow
 * glide moves the transcript with it, and the pill ↔ composer morph grows and
 * shrinks with it, so the keyboard, the composer and the transcript read as
 * one movement.
 *
 * The keyboard rides a critically damped spring with a 0.255 s response:
 * traced frame by frame from a simulator recording, its position matches the
 * spring within 2% of the travel on every frame. The cubic-bezier that stood
 * in for it over 250 ms put the composer at half its travel while the
 * keyboard had covered a quarter, so the composer visibly outran it.
 */
const KEYBOARD_SPRING: SpringSpec = { duration: 0.255, bounce: 0 };

const keyboardCss = springCss(KEYBOARD_SPRING);

/** How long the keyboard takes to land (the spring settled within 0.1%), both ways. */
export const KEYBOARD_SHOW_MS = keyboardCss.durationMs;
export const KEYBOARD_HIDE_MS = keyboardCss.durationMs;

/**
 * Before iOS 17.2 WebKit has no `linear()` easing, and a transition that
 * names one is dropped whole. This curve stays within about 2% of the spring
 * over the same duration.
 */
const KEYBOARD_EASING_FALLBACK = 'cubic-bezier(0.3, 0.55, 0.05, 1)';

const supportsLinearEasing = (): boolean => (
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)')
);

/**
 * The keyboard curve as an easing, for what cannot run on the compositor
 * anyway (a height, a `bottom`, a clip). A transform or an opacity takes
 * `keyboardKeyframes` instead: WebKit hands no animation with a `linear()`
 * easing to Core Animation (KeyframeEffect::canBeAccelerated), so it runs on
 * the main thread at 60 Hz and stalls with it.
 */
export const KEYBOARD_EASING_CSS = supportsLinearEasing() ? keyboardCss.easing : KEYBOARD_EASING_FALLBACK;

/** Progress (0..1 over KEYBOARD_SHOW_MS) → position on the keyboard curve. */
export const keyboardEase = springEase(KEYBOARD_SPRING);

const KEYFRAME_STEPS = 24;

/**
 * Keyframes that trace the keyboard curve, for a Web Animation run with
 * `easing: 'linear'`. Core Animation accelerates keyframes joined by plain
 * linear segments, so the motion keeps the spring's shape and still runs on
 * the compositor at the screen's rate. `frame` builds the keyframe for a
 * point on the curve (0 at the start, 1 at the end).
 */
export const keyboardKeyframes = (frame: (position: number) => Keyframe): Keyframe[] => (
    Array.from({ length: KEYFRAME_STEPS + 1 }, (_, index) => ({
        ...frame(keyboardEase(index / KEYFRAME_STEPS)),
        offset: index / KEYFRAME_STEPS,
    }))
);
