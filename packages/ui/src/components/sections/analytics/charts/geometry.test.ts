import { describe, expect, test } from 'bun:test';
import { computeSparklinePoints, computeBarRects, buildStackedRows } from './geometry';

describe('computeSparklinePoints', () => {
  test('one point per value, monotonic x across width', () => {
    const pts = computeSparklinePoints([0, 5, 10], 60, 20);
    expect(pts).toHaveLength(3);
    expect(pts[0]!.x).toBe(0);
    expect(pts[2]!.x).toBeCloseTo(60, 5);
    expect(pts[2]!.y).toBeLessThan(pts[0]!.y);
  });
  test('empty / single value -> empty array', () => {
    expect(computeSparklinePoints([], 60, 20)).toHaveLength(0);
    expect(computeSparklinePoints([3], 60, 20)).toHaveLength(0);
  });
  test('all-zero values do not divide by zero', () => {
    const pts = computeSparklinePoints([0, 0], 60, 20);
    expect(pts).toHaveLength(2);
  });
});

describe('computeBarRects', () => {
  test('one rect per datum, within bounds, ascending x', () => {
    const rects = computeBarRects(
      [{ label: 'a', value: 1 }, { label: 'b', value: 2 }],
      200, 180, 20,
    );
    expect(rects).toHaveLength(2);
    expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
    for (const r of rects) {
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.height).toBeLessThanOrEqual(180 - 20);
    }
  });
  test('empty data -> empty array', () => {
    expect(computeBarRects([], 200, 180, 20)).toHaveLength(0);
  });
  test('zero max -> zero-height bars', () => {
    const rects = computeBarRects([{ label: 'a', value: 0 }], 200, 180, 20);
    expect(rects[0]!.height).toBe(0);
  });
});

describe('buildStackedRows', () => {
  test('one row per datum, segments stack bottom-up', () => {
    const rows = buildStackedRows(
      [{ label: 'd1', segments: [10, 5] }],
      200, 180, 20,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bars).toHaveLength(2);
    expect(rows[0]!.bars[0]!.seriesIndex).toBe(0);
    expect(rows[0]!.bars[1]!.seriesIndex).toBe(1);
  });
  test('empty data -> empty array', () => {
    expect(buildStackedRows([], 200, 180, 20)).toHaveLength(0);
  });
});
