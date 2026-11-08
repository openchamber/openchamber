import { describe, expect, test } from 'bun:test';
import { axisTicks } from './axisTicks';

describe('axisTicks', () => {
  test('spans the values with round steps', () => {
    expect(axisTicks(0, 241)).toEqual([0, 100, 200, 300]);
    expect(axisTicks(0, 24.6)).toEqual([0, 10, 20, 30]);
    expect(axisTicks(0, 61)).toEqual([0, 20, 40, 60, 80]);
  });

  test('keeps negative values and small fractions clean', () => {
    expect(axisTicks(-3, 7)).toEqual([-5, 0, 5, 10]);
    expect(axisTicks(0, 0.3)).toEqual([0, 0.1, 0.2, 0.3]);
  });

  test('an all-zero series still gets an axis', () => {
    expect(axisTicks(0, 0)).toEqual([0, 0.5]);
  });

  test('a narrow range on a large base keeps its ticks apart, and no values give a plain axis', () => {
    expect(new Set(axisTicks(1e12, 1e12 + 1)).size).toBe(axisTicks(1e12, 1e12 + 1).length);
    expect(axisTicks(Infinity, -Infinity)).toEqual([0, 1]);
    expect(new Set(axisTicks(0, 1e-21)).size).toBe(axisTicks(0, 1e-21).length);
  });

  test('values near the largest number end instead of looping', () => {
    expect(axisTicks(0, Number.MAX_VALUE)).toEqual([0, Number.MAX_VALUE]);
  });
});
