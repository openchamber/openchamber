import { describe, expect, test } from 'bun:test';

import {
  getRecentNavigationVisibleCount,
  getRecentSectionDisplayState,
} from './activitySections';

describe('getRecentNavigationVisibleCount', () => {
  test('keeps targets inside the initial Recent slice unchanged', () => {
    expect(getRecentNavigationVisibleCount(2, 3, 3)).toBe(3);
  });

  test('reveals the entire bounded Recent list for a hidden target', () => {
    expect(getRecentNavigationVisibleCount(3, 3, 8)).toBe(8);
    expect(getRecentNavigationVisibleCount(7, 3, 8)).toBe(8);
  });

  test('uses the available total when fewer than eight sessions exist', () => {
    expect(getRecentNavigationVisibleCount(3, 3, 5)).toBe(5);
  });
});

describe('getRecentSectionDisplayState', () => {
  test('offers Show more while the bounded list is collapsed', () => {
    expect(getRecentSectionDisplayState(8, 3, false)).toEqual({
      visibleCount: 3,
      canShowMore: true,
      canShowFewer: false,
    });
  });

  test('switches to Show fewer after revealing all remaining sessions', () => {
    expect(getRecentSectionDisplayState(8, 3, true)).toEqual({
      visibleCount: 8,
      canShowMore: false,
      canShowFewer: true,
    });
  });

  test('does not render a toggle when the list fits in the initial slice', () => {
    expect(getRecentSectionDisplayState(2, 3, true)).toEqual({
      visibleCount: 2,
      canShowMore: false,
      canShowFewer: false,
    });
  });
});
