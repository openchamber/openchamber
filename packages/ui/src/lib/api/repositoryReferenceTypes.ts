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

export type RepositoryReferenceThread = {
  id: string;
  resolved: boolean;
  outdated?: boolean;
  canResolve: boolean;
  canReply: boolean;
  replies: RepositoryReferenceComment[];
};
