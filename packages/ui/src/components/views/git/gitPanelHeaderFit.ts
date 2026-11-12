/**
 * The Git panel header row gives up room in order (`index.css`): the
 * repository picker truncates down to its icon and chevron, then the branch
 * picker does, and only while the pickers still overflow their slot does the
 * sync button drop its word, keeping its icon, counts and tooltip. At the
 * narrowest panel a branch with ahead and behind counts still does not fit, so
 * the counts go last; the tooltip names them.
 */
export const GIT_PANEL_HEADER_FIT = {
  steps: ['data-git-header-branch-shrinks', 'data-git-header-compact', 'data-git-header-tight'],
  clippedText: '[data-git-header-pickers]',
} as const;
