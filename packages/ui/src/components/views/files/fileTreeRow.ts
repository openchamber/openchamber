// Geometry and row states shared by every file tree; the drawn parts live in
// FileTreeRowParts.tsx.

export const FILE_TREE_INDENT_PX = 12;
export const FILE_TREE_BASE_PADDING_PX = 8;

export type FileTreeGitStatus = 'git-modified' | 'git-added' | 'git-deleted';

/** `basePaddingPx` lets a tree sitting under a differently inset header line up with it. */
export const fileTreeRowPaddingLeft = (depth: number, basePaddingPx = FILE_TREE_BASE_PADDING_PX): string =>
  `${basePaddingPx + depth * FILE_TREE_INDENT_PX}px`;

// The fill also goes to --oc-file-tree-row-fill, which the row's sticky end
// lane paints (`oc-file-tree-row-end` in index.css).
export const fileTreeRowStateClassName = (isActive: boolean): string => (
  isActive
    ? 'bg-interactive-selection text-interactive-selection-foreground [--oc-file-tree-row-fill:var(--interactive-selection)]'
    : 'text-foreground/90 hover:bg-interactive-hover hover:text-foreground hover:[--oc-file-tree-row-fill:var(--interactive-hover)]'
);

/** The fill a row's hover menu lane paints, which sits outside the row's button. */
export const fileTreeRowMenuFillClassName = (isActive: boolean): string => (
  isActive
    ? '[--oc-file-tree-row-fill:var(--interactive-selection)]'
    : 'group-hover:[--oc-file-tree-row-fill:var(--interactive-hover)]'
);
