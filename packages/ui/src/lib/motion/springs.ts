/**
 * Springs for CSS. A spring is named by how long it feels and how much it
 * bounces (the duration and bounce pair other platforms use); `springCss`
 * turns it into a `linear()` easing that traces the spring and the time it
 * takes to settle, so any transition or Web Animation can run it without a
 * frame loop.
 */

export type SpringSpec = {
  /** Perceived duration in seconds: one period of the undamped spring. */
  duration: number;
  /** 0 settles without overshoot; up to about 0.4 reads as playful. */
  bounce: number;
};

type SpringCss = {
  /** The time the spring takes to settle within 0.1% of its target, in ms. */
  durationMs: number;
  easing: string;
};

const SETTLE_EPSILON = 0.001;
const SAMPLE_COUNT = 32;

/** Where a unit spring starting at rest stands after `t` seconds. */
const springPosition = ({ duration, bounce }: SpringSpec, t: number): number => {
  const omega = (2 * Math.PI) / duration;
  const zeta = 1 - Math.min(Math.max(bounce, 0), 0.95);
  if (zeta >= 1) return 1 - (1 + omega * t) * Math.exp(-omega * t);
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + (zeta * omega / damped) * Math.sin(damped * t));
};

const settleTime = (spring: SpringSpec): number => {
  const step = 0.001;
  const limit = spring.duration * 4;
  let settled = limit;
  for (let t = limit; t >= 0; t -= step) {
    if (Math.abs(1 - springPosition(spring, t)) >= SETTLE_EPSILON) break;
    settled = t;
  }
  return settled;
};

const round = (value: number): string => String(Math.round(value * 10000) / 10000);

/**
 * The spring as an easing function of progress (0..1 over its settle time),
 * for motion driven from JavaScript on the same curve its `linear()` traces.
 */
export const springEase = (spring: SpringSpec): ((progress: number) => number) => {
  const settle = settleTime(spring);
  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    return springPosition(spring, settle * progress);
  };
};

export const springCss = (spring: SpringSpec): SpringCss => {
  const settle = settleTime(spring);
  const points: string[] = [];
  for (let index = 0; index <= SAMPLE_COUNT; index += 1) {
    const value = index === SAMPLE_COUNT ? 1 : springPosition(spring, (settle * index) / SAMPLE_COUNT);
    points.push(round(value));
  }
  return { durationMs: Math.round(settle * 1000), easing: `linear(${points.join(', ')})` };
};

/**
 * The app's springs. Popups (menus, selects, tooltips) open on a short spring
 * with a touch of bounce and close on a plain fade; layout moves (a panel
 * resizing, a row opening) take a calmer one without bounce.
 */
export const MOTION_SPRINGS = {
  popup: { duration: 0.24, bounce: 0.08 },
  layout: { duration: 0.2, bounce: 0 },
} as const satisfies Record<string, SpringSpec>;

export type MotionSpringName = keyof typeof MOTION_SPRINGS;

export const MOTION_SPRING_NAMES: readonly MotionSpringName[] = ['popup', 'layout'];

/** The CSS custom properties a spring writes, as property and value pairs: `--oc-motion-<name>-duration` and `-easing`. */
export const springCssVariables = (name: MotionSpringName, spring: SpringSpec): readonly (readonly [string, string])[] => {
  const css = springCss(spring);
  return [
    [`--oc-motion-${name}-duration`, `${css.durationMs}ms`],
    [`--oc-motion-${name}-easing`, css.easing],
  ];
};

/**
 * A CSS time in milliseconds, or 0 when it is not one. The production CSS
 * minifier rewrites `294ms` as `.294s`, so a reader that took the number as
 * milliseconds ran every animation for a fraction of a millisecond.
 */
export const parseCssTimeMs = (value: string): number => {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/u.exec(value.trim());
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
};
