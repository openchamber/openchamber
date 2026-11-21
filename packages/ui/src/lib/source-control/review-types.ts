import type { SourceControlUser } from './types';

export type ReviewerStateValue = 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface ChangeRequestReviewerState {
  user: SourceControlUser;
  state: ReviewerStateValue;
}
