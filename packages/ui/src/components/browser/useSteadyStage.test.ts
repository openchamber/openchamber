import { describe, expect, test } from 'bun:test';
import { pinnedPageWidth } from './useSteadyStage';

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
