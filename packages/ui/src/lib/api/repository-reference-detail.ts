import type {
  ChangeRequestRevision,
  ChangeRequestSubmitRequirement,
  ChangeRequestVoteLabel,
  CISummary,
  PullRequestStack,
} from '../source-control/types';
import type {
  RepositoryReferenceComment,
  RepositoryReferenceCommit,
  RepositoryReferenceReviewer,
} from './types';

export type RepositoryReferenceDetail = {
  number: number;
  body?: string;
  viewerCanUpdate?: boolean;
  assignees?: RepositoryReferenceReviewer[];
  locked?: boolean;
  viewerSubscribed?: boolean;
  comments: RepositoryReferenceComment[];
  commentTotal: number;
  pull: {
    reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
    reviewers: RepositoryReferenceReviewer[];
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
  discussion?: { canComment: boolean; canClose: boolean; canReopen: boolean };
  writeAccess?: boolean;
};
