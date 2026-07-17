import { describe, expect, test } from 'bun:test';

import { allotmentSizesToFractions, applyBranchSizes, branchToDefaultSizes } from './layoutToAllotment';
import type { SplitBranch, TabGroupLeaf } from './splitTree';

const leaf = (id: string): TabGroupLeaf => ({ kind: 'group', id, tileIds: [`${id}-t`], activeTileId: `${id}-t` });

describe('branchToDefaultSizes', () => {
  test('passes valid fractions through', () => {
    expect(branchToDefaultSizes([0.25, 0.75])).toEqual([0.25, 0.75]);
  });

  test('zeroes out non-finite or non-positive entries', () => {
    expect(branchToDefaultSizes([Number.NaN, -1, 0.5])).toEqual([0, 0, 0.5]);
  });
});

describe('allotmentSizesToFractions', () => {
  test('normalizes pixel sizes to fractions summing to 1', () => {
    const result = allotmentSizesToFractions([300, 100]);
    expect(result).toEqual([0.75, 0.25]);
    expect(result.reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  test('preserves ratio regardless of total', () => {
    expect(allotmentSizesToFractions([2, 2])).toEqual([0.5, 0.5]);
  });

  test('falls back to equal split on zero total', () => {
    expect(allotmentSizesToFractions([0, 0])).toEqual([0.5, 0.5]);
  });

  test('falls back to equal split on non-finite input', () => {
    expect(allotmentSizesToFractions([Number.NaN, 10])).toEqual([0.5, 0.5]);
  });

  test('returns empty for empty input', () => {
    expect(allotmentSizesToFractions([])).toEqual([]);
  });
});

describe('applyBranchSizes', () => {
  const root: SplitBranch = {
    kind: 'split',
    direction: 'horizontal',
    children: [leaf('a'), leaf('b')],
    sizes: [0.5, 0.5],
  };

  test('replaces the root branch sizes with normalized fractions', () => {
    const next = applyBranchSizes(root, [], [300, 100]);
    expect(next).not.toBe(root);
    expect((next as SplitBranch).sizes).toEqual([0.75, 0.25]);
  });

  test('replaces a nested branch and preserves siblings by reference', () => {
    const nestedChild = leaf('c');
    const nested: SplitBranch = { kind: 'split', direction: 'vertical', children: [nestedChild, leaf('d')], sizes: [0.5, 0.5] };
    const sibling = leaf('e');
    const tree: SplitBranch = { kind: 'split', direction: 'horizontal', children: [sibling, nested], sizes: [0.5, 0.5] };

    const next = applyBranchSizes(tree, [1], [1, 3]) as SplitBranch;
    expect(next).not.toBe(tree);
    expect(next.children[0]).toBe(sibling); // untouched sibling reused
    expect((next.children[1] as SplitBranch).sizes).toEqual([0.25, 0.75]);
    expect((next.children[1] as SplitBranch).children[0]).toBe(nestedChild); // deep leaf reused
  });

  test('returns the same tree when the path length mismatches child count', () => {
    expect(applyBranchSizes(root, [], [1, 2, 3])).toBe(root);
  });

  test('returns the same tree for an out-of-range index', () => {
    expect(applyBranchSizes(root, [5], [1, 2])).toBe(root);
  });

  test('returns the same node when targeting a leaf', () => {
    const soloLeaf = leaf('solo');
    expect(applyBranchSizes(soloLeaf, [], [1, 2])).toBe(soloLeaf);
  });
});
