import { springCss, springEase, type SpringSpec } from '@/lib/motion/springs';

const KEYBOARD_SPRING: SpringSpec = { duration: 0.255, bounce: 0 };

const keyboardCss = springCss(KEYBOARD_SPRING);

export const KEYBOARD_SHOW_MS = keyboardCss.durationMs;
export const KEYBOARD_HIDE_MS = keyboardCss.durationMs;

// external: https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/linear WebKit before iOS 17.2 drops transitions using linear() easing.
const KEYBOARD_EASING_FALLBACK = 'cubic-bezier(0.3, 0.55, 0.05, 1)';

const supportsLinearEasing = (): boolean => (
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)')
);

// external: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/animation/KeyframeEffect.cpp canBeAccelerated rejects linear() easing; compositor motion uses plain-linear keyframe segments.
export const KEYBOARD_EASING_CSS = supportsLinearEasing() ? keyboardCss.easing : KEYBOARD_EASING_FALLBACK;

export const keyboardEase = springEase(KEYBOARD_SPRING);

const KEYFRAME_STEPS = 24;

export const keyboardKeyframes = (frame: (position: number) => Keyframe): Keyframe[] => (
    Array.from({ length: KEYFRAME_STEPS + 1 }, (_, index) => ({
        ...frame(keyboardEase(index / KEYFRAME_STEPS)),
        offset: index / KEYFRAME_STEPS,
    }))
);
