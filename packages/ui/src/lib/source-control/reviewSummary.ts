export type RepositoryReferenceReview = {
  id: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'pending' | 'dismissed';
  author: { login: string; avatarUrl?: string } | null;
  submittedAt: string | null;
};
