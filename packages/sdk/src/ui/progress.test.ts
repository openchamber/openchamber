import { describe, expect, test } from 'bun:test';

import { clampProgress } from './progress.ts';

describe('clampProgress', () => {
  test('clamps into 0..100 and never shows 100 before it is done', () => {
    expect(clampProgress(-5)).toBe(0);
    expect(clampProgress(42.6)).toBe(42);
    expect(clampProgress(99.6)).toBe(99);
    expect(clampProgress(100)).toBe(100);
    expect(clampProgress(150)).toBe(100);
  });

  test('treats a non-finite value as empty', () => {
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
