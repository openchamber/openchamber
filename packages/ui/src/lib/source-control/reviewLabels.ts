import type { SourceControlProviderDescriptor } from './providers/descriptor';
import type { ChangeRequestVoteLabel, ReviewVerdict } from './types';

/**
 * What a verdict host reviews on: approve, or request changes with text. One
 * label the host never names, so verdict hosts keep today's two buttons and
 * send `{ verdict, body }` as before.
 */
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

/**
 * The labels a change request is reviewed on: the implicit approval label for
 * a verdict host, or the labels a votes host names on the change itself
 * (none until its context is read). How a host reviews is the descriptor's
 * `features.reviewModel`; which labels exist is per change, so only its
 * context can say.
 */
export const reviewLabelsOf = (
  descriptor: SourceControlProviderDescriptor,
  context: { voteLabels?: ChangeRequestVoteLabel[] } | null | undefined,
): ReviewLabels => (
  descriptor.features.reviewModel === 'votes'
    ? { model: 'votes', labels: context?.voteLabels ?? [] }
    : { model: 'verdict', labels: [APPROVAL_LABEL] }
);

/** A vote as hosts write it: `+2`, `0`, `-1`. */
export const formatVoteValue = (value: number): string => (value > 0 ? `+${value}` : String(value));
