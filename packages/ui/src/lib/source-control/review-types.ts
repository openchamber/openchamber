import type { ReviewCommentSide, SourceControlUser } from './types';

export type ReviewerStateValue = 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface ChangeRequestReviewerState {
  user: SourceControlUser;
  state: ReviewerStateValue;
}

export interface ReviewPerson {
  login: string;
  avatarUrl?: string;
}

export interface ReviewDraftComment {
  id: string;
  path: string;
  side: ReviewCommentSide;
  line: number | null;
  startLine: number | null;
  body: string;
  author: ReviewPerson | null;
}

export interface ReviewThreadComment {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: ReviewPerson | null;
}

export interface ReviewThread {
  id: string;
  path: string;
  side: ReviewCommentSide;
  line: number | null;
  startLine: number | null;
  resolved: boolean;
  outdated?: boolean;
  canReply: boolean;
  canResolve: boolean;
  comments: ReviewThreadComment[];
}

export interface ChangeRequestReviewState {
  viewerIsAuthor: boolean;
  headSha: string;
  draft: { id: string; body: string; comments: ReviewDraftComment[] } | null;
  threads: ReviewThread[];
  truncated: boolean;
}
