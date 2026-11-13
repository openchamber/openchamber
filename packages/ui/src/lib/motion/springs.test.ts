import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MOTION_SPRING_NAMES, MOTION_SPRINGS, springCss, springCssVariables, parseCssTimeMs } from './springs';

describe('springCss', () => {
  test('starts at rest, ends on target, and settles later with more bounce', () => {
    const calm = springCss({ duration: 0.3, bounce: 0 });
    const lively = springCss({ duration: 0.3, bounce: 0.3 });
    expect(calm.easing.startsWith('linear(0, ')).toBe(true);
    expect(calm.easing.endsWith(', 1)')).toBe(true);
    expect(lively.durationMs).toBeGreaterThan(calm.durationMs);
  });

  test('a bouncy spring overshoots its target', () => {
    const values = springCss({ duration: 0.3, bounce: 0.3 }).easing.slice('linear('.length, -1).split(', ').map(Number);
    expect(Math.max(...values)).toBeGreaterThan(1);
  });

  test('the stylesheet defaults are the springs this module defines', () => {
    const css = readFileSync(new URL('../../styles/design-system.css', import.meta.url), 'utf8');
    for (const name of MOTION_SPRING_NAMES) {
      for (const [property, value] of springCssVariables(name, MOTION_SPRINGS[name])) {
        expect(css).toContain(`${property}: ${value};`);
      }
    }
  });
});

describe('parseCssTimeMs', () => {
  test('reads milliseconds and the seconds a minifier writes', () => {
    expect(parseCssTimeMs('294ms')).toBe(294);
    expect(parseCssTimeMs('.294s')).toBe(294);
    expect(parseCssTimeMs(' 0.25s ')).toBe(250);
  });

  test('anything else is no duration', () => {
    expect(parseCssTimeMs('')).toBe(0);
    expect(parseCssTimeMs('294')).toBe(0);
    expect(parseCssTimeMs('var(--x)')).toBe(0);
  });
});
