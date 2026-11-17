
export type SpringSpec = {
  duration: number;
  bounce: number;
};

type SpringCss = {
  durationMs: number;
  easing: string;
};

const SETTLE_EPSILON = 0.001;
const SAMPLE_COUNT = 32;

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

export const MOTION_SPRINGS = {
  popup: { duration: 0.24, bounce: 0.08 },
  layout: { duration: 0.2, bounce: 0 },
} as const satisfies Record<string, SpringSpec>;

export type MotionSpringName = keyof typeof MOTION_SPRINGS;

export const MOTION_SPRING_NAMES: readonly MotionSpringName[] = ['popup', 'layout'];

export const springCssVariables = (name: MotionSpringName, spring: SpringSpec): readonly (readonly [string, string])[] => {
  const css = springCss(spring);
  return [
    [`--oc-motion-${name}-duration`, `${css.durationMs}ms`],
    [`--oc-motion-${name}-easing`, css.easing],
  ];
};

export const parseCssTimeMs = (value: string): number => {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/u.exec(value.trim());
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
};
