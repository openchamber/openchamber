import { describe, expect, test } from 'bun:test';
import { SESSION_TAB_EDGE_FADE_PX, sessionTabRevealDelta } from './sessionTabReveal';

const viewport = { left: 0, right: 420 };

describe('session tab reveal', () => {
  test('a tab that already fits with room at both ends does not move', () => {
    expect(sessionTabRevealDelta(viewport, { left: 100, right: 300 })).toBe(0);
  });

  test('a tab flush in the fade zone is pulled clear of the end edge', () => {
    expect(sessionTabRevealDelta(viewport, { left: 100, right: 420 })).toBe(SESSION_TAB_EDGE_FADE_PX);
  });

  test('a tab flush in the start fade is pushed clear of the start edge', () => {
    expect(sessionTabRevealDelta(viewport, { left: 0, right: 200 })).toBe(-SESSION_TAB_EDGE_FADE_PX);
  });

  test('resting exactly on both inset limits is already enough', () => {
    const inset = SESSION_TAB_EDGE_FADE_PX;
    expect(sessionTabRevealDelta(viewport, { left: inset, right: viewport.right - inset })).toBe(0);
  });

  test('a tab wider than the two insets keeps its end edge and clips the start', () => {
    expect(sessionTabRevealDelta(viewport, { left: 0, right: 500 })).toBe(500 - (viewport.right - SESSION_TAB_EDGE_FADE_PX));
  });

  test('the inset can be overridden for a wider fade', () => {
    expect(sessionTabRevealDelta(viewport, { left: 100, right: 420 }, 40)).toBe(40);
    expect(sessionTabRevealDelta(viewport, { left: 0, right: 200 }, 40)).toBe(-40);
  });
});
