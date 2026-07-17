import { describe, expect, test } from 'bun:test';

import { createSingleGroup, splitLeaf } from './splitTree';
import { computeVisibleTileIds } from './visibleTileIds';

describe('computeVisibleTileIds', () => {
  test('returns active tile from single group when panel is open', () => {
    const layout = createSingleGroup(['inactive', 'active'], 'active');

    const result = computeVisibleTileIds(layout, true);

    expect(result).toEqual(new Set(['active']));
  });

  test('returns active tile from every rendered group', () => {
    const layout = splitLeaf(createSingleGroup(['left', 'right'], 'left'), 'group-1', 'right', 'right');

    const result = computeVisibleTileIds(layout, true);

    expect(result).toEqual(new Set(['left', 'right']));
  });

  test('excludes inactive tiles within groups', () => {
    const layout = createSingleGroup(['inactive', 'active'], 'active');

    const result = computeVisibleTileIds(layout, true);

    expect(result.has('inactive')).toBe(false);
  });

  test('returns no tiles when panel is closed', () => {
    const layout = createSingleGroup(['active'], 'active');

    const result = computeVisibleTileIds(layout, false);

    expect(result).toEqual(new Set());
  });
});
