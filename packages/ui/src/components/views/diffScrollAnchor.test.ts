import { describe, expect, test } from 'bun:test';

import { findDiffScrollAnchor, getRestoredDiffScrollTop } from './diffScrollAnchor';

describe('diff scroll anchoring', () => {
  test('uses the last file section that reached the top of the viewport', () => {
    expect(findDiffScrollAnchor(100, [
      { path: 'third.ts', top: 240 },
      { path: 'second.ts', top: 80 },
      { path: 'first.ts', top: -200 },
    ])).toEqual({ path: 'second.ts', topOffset: -20 });
  });

  test('uses the first section when no header reached the viewport top yet', () => {
    expect(findDiffScrollAnchor(100, [
      { path: 'first.ts', top: 140 },
      { path: 'second.ts', top: 300 },
    ])).toEqual({ path: 'first.ts', topOffset: 40 });
  });

  test('restores the prior section offset and clamps at the scroll boundary', () => {
    expect(getRestoredDiffScrollTop(500, -20, 80, 1000)).toBe(600);
    expect(getRestoredDiffScrollTop(950, -20, 80, 1000)).toBe(1000);
  });
});
