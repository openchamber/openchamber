export type GitReviewLayout = 'separate' | 'combined';

export function getWorkingTreeDiffDestination(input: {
  reviewLayout: GitReviewLayout;
  isMobile: boolean;
  isVSCode: boolean;
}): 'context' | 'main' {
  return input.reviewLayout === 'combined' && !input.isMobile && !input.isVSCode
    ? 'main'
    : 'context';
}
