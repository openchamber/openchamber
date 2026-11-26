import type {
  ChangeRequestContext,
  ChangeRequestRevision,
  ChangeRequestSubmitRequirement,
  ChangeRequestVoteLabel,
  CISummary,
  PullRequestStack,
} from '../source-control/types';
import type { RepositoryReferenceCommit, RepositoryReferenceReviewer, RepositoryReferenceReviewerState } from './repositoryReferenceTypes';
import type { RepositoryReferenceComment } from './repositoryReferenceTypes';
import type { RepositoryReferenceReview } from '../source-control/reviewSummary';

export type RepositoryReferenceDetail = {
  number: number;
  body?: string;
  viewerCanUpdate?: boolean;
  writeAccess?: boolean;
  branchWriteAccess?: boolean;
  threadsUnavailable?: boolean;
  assignees?: RepositoryReferenceReviewer[];
  comments: RepositoryReferenceComment[];
  commentTotal: number;
  pull: {
    reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
    reviewers: RepositoryReferenceReviewer[];
    reviewerStates?: RepositoryReferenceReviewerState[];
    reviews?: RepositoryReferenceReview[];
    canDismissReviews?: boolean;
    additions: number;
    deletions: number;
    changedFiles: number;
    checks?: CISummary | null;
    commits: RepositoryReferenceCommit[];
    commitTotal: number | null;
    stack?: PullRequestStack | null;
    voteLabels?: ChangeRequestVoteLabel[];
    submitRequirements?: ChangeRequestSubmitRequirement[];
    revisions?: ChangeRequestRevision[];
  } | null;
  references?: ChangeRequestContext['references'];
  discussion?: { canComment: boolean; canClose: boolean; canReopen: boolean };
};
