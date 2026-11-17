import type {
  ChangeRequestRevision,
  ChangeRequestSubmitRequirement,
  ChangeRequestVoteLabel,
  CISummary,
  PullRequestStack,
} from '../source-control/types';
import type { RepositoryReferenceReview } from '../source-control/reviewSummary';

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

export type RepositoryReferenceReviewer = {
  id: string;
  login: string;
  avatarUrl?: string;
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
  discussion?: { canComment: boolean; canClose: boolean; canReopen: boolean };
};

type RepositoryReferenceCommit = {
  sha: string;
  headline: string;
  author: { login: string; avatarUrl?: string } | null;
  authorName: string | null;
  committedAt: string | null;
  url: string | null;
};

export type RepositoryReferenceDetailResult =
  | { connected: false }
  | { connected: true; detail: RepositoryReferenceDetail | null };
