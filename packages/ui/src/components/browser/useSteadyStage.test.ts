import { describe, expect, test } from 'bun:test';
import { pageWidthAtStart, pinnedPageWidth } from './useSteadyStage';

describe('pinnedPageWidth', () => {
  test('keeps the resting width while the stage shrinks', () => {
    expect(pinnedPageWidth(null, 900, 640)).toBe(900);
    expect(pinnedPageWidth(900, 900, 320)).toBe(900);
  });

  test('grows once, a step past the stage, when the stage outgrows the page', () => {
    const first = pinnedPageWidth(null, 900, 910.4);
    expect(first).toBe(1151);
    // The frames that follow fit inside it: no further resize.
    expect(pinnedPageWidth(first, 900, 1000)).toBe(first);
    expect(pinnedPageWidth(first, 900, 1151)).toBe(first);
    expect(pinnedPageWidth(first, 900, 1152)).toBe(1392);
  });
});

describe('pageWidthAtStart', () => {
  test('takes the final width at once when the zone grows to a known size', () => {
    expect(pageWidthAtStart(902, 916, 1106)).toBe(1092);
  });

  test('keeps its width when the zone shrinks, stays, or says nothing', () => {
    expect(pageWidthAtStart(1092, 1106, 916)).toBe(1092);
    expect(pageWidthAtStart(902, 916, 916)).toBe(902);
    expect(pageWidthAtStart(902, null, 916)).toBe(902);
    expect(pageWidthAtStart(902, 916, null)).toBe(902);
  });
});
