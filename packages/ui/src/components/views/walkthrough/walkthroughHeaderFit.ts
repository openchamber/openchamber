export const WALKTHROUGH_HEADER_PICKER_ATTRIBUTE = 'data-walkthrough-header-picker';

export const WALKTHROUGH_HEADER_FIT = {
  steps: [
    'data-walkthrough-header-compact',
    'data-walkthrough-header-tight',
    'data-walkthrough-header-minimal',
    'data-walkthrough-header-narrow',
  ],
  clippedText: `[${WALKTHROUGH_HEADER_PICKER_ATTRIBUTE}] > button > .truncate`,
  clippedTextCeilingRem: 12,
} as const;
