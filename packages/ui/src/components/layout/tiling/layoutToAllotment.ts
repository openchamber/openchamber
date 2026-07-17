import type { SplitNode } from './splitTree';

/**
 * Pure mappers between a {@link SplitBranch}'s normalized `sizes` (fractions that
 * sum to 1) and the number arrays `allotment` speaks.
 *
 * - `branchToDefaultSizes` feeds `<Allotment defaultSizes>` (allotment treats the
 *   array as relative proportions, so passing the stored fractions is enough).
 * - `allotmentSizesToFractions` takes the pixel array from `onDragEnd` back to
 *   normalized fractions for persistence.
 * - `applyBranchSizes` addresses a branch by a path of child indices and returns a
 *   new tree with that branch's `sizes` replaced, preserving every other node by
 *   reference (referential-equality discipline).
 */

const equalFractions = (count: number): number[] =>
  count > 0 ? Array.from({ length: count }, () => 1 / count) : [];

export const branchToDefaultSizes = (sizes: number[]): number[] =>
  sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0));

export const allotmentSizesToFractions = (pixelSizes: number[]): number[] => {
  if (pixelSizes.length === 0) return [];
  const allValid = pixelSizes.every((size) => Number.isFinite(size) && size >= 0);
  const total = pixelSizes.reduce((sum, size) => sum + size, 0);
  if (!allValid || total <= 0) return equalFractions(pixelSizes.length);
  return pixelSizes.map((size) => size / total);
};

export const applyBranchSizes = (root: SplitNode, path: number[], fractions: number[]): SplitNode => {
  if (path.length === 0) {
    if (root.kind !== 'split' || root.children.length !== fractions.length) return root;
    return { ...root, sizes: allotmentSizesToFractions(fractions) };
  }

  if (root.kind !== 'split') return root;
  const [index, ...rest] = path;
  if (index < 0 || index >= root.children.length) return root;

  const child = root.children[index];
  if (child === undefined) return root;
  const nextChild = applyBranchSizes(child, rest, fractions);
  if (nextChild === child) return root;

  const children = root.children.map((existing, i) => (i === index ? nextChild : existing));
  return { ...root, children };
};
