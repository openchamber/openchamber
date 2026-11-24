import type {
  CISummary,
  ChangeRequestContext,
  ChangeRequestRevision,
  ChangeRequestSubmitRequirement,
  ChangeRequestVoteLabel,
  PullRequestStack,
} from '../source-control/types';
import type { RepositoryReferenceReview } from '../source-control/reviewSummary';
import type { ReviewerStateValue } from '../source-control/review-types';

export type RepositoryReferenceReviewer = {
  id: string;
  login: string;
  avatarUrl?: string;
};

export type RepositoryReferenceReviewerState = RepositoryReferenceReviewer & { state: ReviewerStateValue };

export type RepositoryReferenceCommit = {
  sha: string;
  headline: string;
  author: { login: string; avatarUrl?: string } | null;
  authorName: string | null;
  committedAt: string | null;
  url: string | null;
};

export type ReviewCommentExcerpt = { startLine: number; lines: string[] };

export type RepositoryReferenceComment = {
  author: { login: string; avatarUrl?: string } | null;
  body: string;
  createdAt: string | null;
  url: string;
  id?: string;
  canUpdate?: boolean;
  canDelete?: boolean;
  path: string | null;
  line: number | null;
  review: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | null;
  excerpt?: ReviewCommentExcerpt;
  thread?: RepositoryReferenceThread;
  answer?: { chosen: boolean; canChange: boolean };
};

type RepositoryReferenceThread = {
  id: string;
  resolved: boolean;
  canResolve: boolean;
  canReply: boolean;
  outdated?: boolean;
  replies: RepositoryReferenceComment[];
};

export type RepositoryReferenceDetail = {
  number: number;
  body?: string;
  viewerCanUpdate?: boolean;
  comments: RepositoryReferenceComment[];
  commentTotal: number;
  pull: {
    reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
    reviewers: RepositoryReferenceReviewer[];
    reviewerStates?: RepositoryReferenceReviewerState[];
    reviews?: RepositoryReferenceReview[];
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

export type RepositoryReferenceDetailResult =
  | { connected: false }
  | { connected: true; detail: RepositoryReferenceDetail | null };
