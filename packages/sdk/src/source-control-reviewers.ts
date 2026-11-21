export type SourceControlReviewerState = {
  user: { id: string; username: string; avatarUrl?: string };
  state: 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
};

export type SourceControlChangeRequestContext = {
  reviewerStates?: SourceControlReviewerState[];
};
