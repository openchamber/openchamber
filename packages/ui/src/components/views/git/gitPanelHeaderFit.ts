export const GIT_PANEL_REVIEW_MENU_STEP = 'data-git-header-review-menu';

export const GIT_PANEL_HEADER_FIT = {
  steps: [
    'data-git-header-review-icons',
    'data-git-header-compact',
    'data-git-header-tight',
    GIT_PANEL_REVIEW_MENU_STEP,
    'data-git-header-scope-short',
  ],
  clippedText: '.change-scope__label',
} as const;

export const REVIEW_SCOPE_TOOLBAR_FIT = {
  steps: ['data-git-header-review-icons', GIT_PANEL_REVIEW_MENU_STEP, 'data-git-header-scope-short'],
  clippedText: '.change-scope__label',
} as const;
