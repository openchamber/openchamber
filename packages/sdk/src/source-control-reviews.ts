export const SOURCE_CONTROL_REVIEW_STATES = [
  'approved',
  'changes_requested',
  'commented',
  'pending',
  'dismissed',
] as const;

export type SourceControlReviewState = (typeof SOURCE_CONTROL_REVIEW_STATES)[number];

export type SourceControlReviewSummary = {
  id: string;
  state: SourceControlReviewState;
  author?: { login: string; avatarUrl?: string } | null;
  submittedAt?: string | null;
};
