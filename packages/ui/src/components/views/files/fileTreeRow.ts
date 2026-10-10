// Geometry and row states shared by every file tree; the drawn parts live in
// FileTreeRowParts.tsx.

export const FILE_TREE_INDENT_PX = 12;
export const FILE_TREE_BASE_PADDING_PX = 8;

export type FileTreeGitStatus = 'git-modified' | 'git-added' | 'git-deleted';

export const fileTreeRowPaddingLeft = (depth: number): string =>
  `${FILE_TREE_BASE_PADDING_PX + depth * FILE_TREE_INDENT_PX}px`;

export const fileTreeRowStateClassName = (isActive: boolean): string => (
  isActive
    ? 'bg-interactive-selection text-interactive-selection-foreground'
    : 'text-foreground/90 hover:bg-interactive-hover hover:text-foreground'
);
