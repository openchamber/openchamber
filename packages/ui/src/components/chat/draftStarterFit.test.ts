import { describe, expect, test } from 'bun:test';

import { countFittingStarters, moveToFrontTarget } from './draftStarterFit';

describe('countFittingStarters', () => {
  test('every chip fits: null, so nothing hides', () => {
    expect(countFittingStarters([100, 80, 120], 400, 6, 24)).toBeNull();
    expect(countFittingStarters([], 0, 6, 24)).toBeNull();
  });

  test('counts the chips that fit before the "+" and its gap', () => {
    // 400 - 24 ("+") - 6 (its gap) = 370: 100 + 6 + 80 + 6 + 120 = 312 fits, the next 70 does not.
    expect(countFittingStarters([100, 80, 120, 70], 400, 6, 24)).toBe(3);
  });

  test('a chip that ends exactly at the edge fits', () => {
    expect(countFittingStarters([100, 100], 236, 6, 24)).toBeNull();
    expect(countFittingStarters([100, 100], 235, 6, 24)).toBe(1);
  });

  test('a row too narrow for the first chip shows none', () => {
    expect(countFittingStarters([200, 50], 100, 6, 24)).toBe(0);
  });

  test('fractional widths add up exactly: no rounding drift drops a chip that fits', () => {
    // Eight chips of 40.4px with 6px gaps take 365.2px; rounding each up to
    // 41 would have needed 370 and hidden the last one.
    const widths = Array.from({ length: 8 }, () => 40.4);
    expect(countFittingStarters(widths, 365.2 + 6 + 24, 6, 24)).toBeNull();
  });

  test('the count depends only on the widths and the room, so the same room gives the same answer', () => {
    const widths = [120, 140, 90, 110];
    const first = countFittingStarters(widths, 300, 6, 24);
    expect(first).toBe(2);
    // The room is the row's own width, which hiding chips must not change:
    // asking again with the same room keeps the same chips.
    expect(countFittingStarters(widths, 300, 6, 24)).toBe(first);
    expect(countFittingStarters(widths, 700, 6, 24)).toBeNull();
  });
});

describe('moveToFrontTarget', () => {
  const own = (id: string) => ({ id, shared: false });
  const team = (id: string) => ({ id, shared: true });

  test('a hidden starter moves ahead of the first of the user\'s own', () => {
    expect(moveToFrontTarget(own('c'), [own('a'), own('b'), own('c')])).toBe('a');
  });

  test('shared starters stay in front: the move lands after them', () => {
    expect(moveToFrontTarget(own('c'), [team('s'), own('a'), own('c')])).toBe('a');
  });

  test('a shared starter cannot move, and one already first has nowhere to go', () => {
    expect(moveToFrontTarget(team('s'), [team('s'), own('a')])).toBeNull();
    expect(moveToFrontTarget(own('a'), [team('s'), own('a')])).toBeNull();
  });
});
