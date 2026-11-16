import type { SourceControlProviderDescriptor } from './providers/descriptor';
import type { ChangeRequestVoteLabel, ReviewVerdict } from './types';

type ApprovalLabel = {
  name: 'approval';
  implicit: true;
  options: ReadonlyArray<{ verdict: ReviewVerdict; requiresBody: boolean }>;
};

const APPROVAL_LABEL: ApprovalLabel = {
  name: 'approval',
  implicit: true,
  options: [{ verdict: 'approve', requiresBody: false }, { verdict: 'request-changes', requiresBody: true }],
};

type ReviewLabels =
  | { model: 'verdict'; labels: readonly [ApprovalLabel] }
  | { model: 'votes'; labels: ChangeRequestVoteLabel[] };

export const reviewLabelsOf = (
  descriptor: SourceControlProviderDescriptor,
  context: { voteLabels?: ChangeRequestVoteLabel[] } | null | undefined,
): ReviewLabels => (
  descriptor.features.reviewModel === 'votes'
    ? { model: 'votes', labels: context?.voteLabels ?? [] }
    : { model: 'verdict', labels: [APPROVAL_LABEL] }
);

export const formatVoteValue = (value: number): string => (value > 0 ? `+${value}` : String(value));
