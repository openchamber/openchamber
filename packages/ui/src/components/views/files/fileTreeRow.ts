
export const FILE_TREE_INDENT_PX = 12;
export const FILE_TREE_BASE_PADDING_PX = 8;

export type FileTreeGitStatus = 'git-modified' | 'git-added' | 'git-deleted';

export const fileTreeRowPaddingLeft = (depth: number, basePaddingPx = FILE_TREE_BASE_PADDING_PX): string =>
  `${basePaddingPx + depth * FILE_TREE_INDENT_PX}px`;

export const fileTreeRowStateClassName = (isActive: boolean): string => (
  isActive
    ? 'bg-interactive-selection text-interactive-selection-foreground [--oc-file-tree-row-fill:var(--interactive-selection)]'
    : 'text-foreground/90 hover:bg-interactive-hover hover:text-foreground hover:[--oc-file-tree-row-fill:var(--interactive-hover)]'
);

export const fileTreeRowMenuFillClassName = (isActive: boolean): string => (
  isActive
    ? '[--oc-file-tree-row-fill:var(--interactive-selection)]'
    : 'group-hover:[--oc-file-tree-row-fill:var(--interactive-hover)]'
);
