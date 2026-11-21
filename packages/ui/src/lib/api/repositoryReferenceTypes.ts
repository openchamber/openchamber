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
