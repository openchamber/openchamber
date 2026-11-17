import type { SourceControlOutboundMethod } from '@openchamber/sdk';

export type ReviewSummaryCall = {
  session: { instance: string; handle: string; user: { id: number | string; login: string } | null };
  identity: { provider: string; instance: string };
};

export type ReviewSummaryRepo = { owner: string; name: string };

type ReviewUser = { login: string; avatar_url?: string };
type Review = {
  id: number;
  state: string;
  user?: ReviewUser;
  submitted_at?: string;
  dismissed?: boolean;
  stale?: boolean;
};

export type ReviewSummaryData = {
  id: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'pending' | 'dismissed';
  author: { login: string; avatarUrl?: string } | null;
  submittedAt: string | null;
};

export type ReviewSummariesDeps = {
  api: <T>(
    call: ReviewSummaryCall,
    method: SourceControlOutboundMethod,
    path: string,
  ) => Promise<{ data: T }>;
  repoPath: (repo: ReviewSummaryRepo) => string;
};

const stateOf = (review: Review): ReviewSummaryData['state'] | null => {
  if (review.dismissed === true || review.state === 'DISMISSED') return 'dismissed';
  switch (review.state) {
    case 'APPROVED': return 'approved';
    case 'REQUEST_CHANGES': return 'changes_requested';
    case 'COMMENT': return 'commented';
    case 'PENDING': return 'pending';
    default: return null;
  }
};

const summaryOf = (review: Review): ReviewSummaryData | null => {
  if (!Number.isSafeInteger(review.id)) return null;
  if (review.state === 'REQUEST_REVIEW' || review.stale === true) return null;
  const state = stateOf(review);
  if (!state) return null;
  const user = review.user;
  const author = user?.login
    ? (user.avatar_url ? { login: user.login, avatarUrl: user.avatar_url } : { login: user.login })
    : null;
  return { id: String(review.id), state, author, submittedAt: review.submitted_at ?? null };
};

export const createReviewSummaries = ({ api, repoPath }: ReviewSummariesDeps) => ({
  read: async (
    call: ReviewSummaryCall,
    repo: ReviewSummaryRepo,
    number: number,
  ): Promise<ReviewSummaryData[] | undefined> => {
    let reviews: Review[];
    try {
      ({ data: reviews } = await api<Review[]>(call, 'GET', `${repoPath(repo)}/pulls/${number}/reviews`));
    } catch {
      return undefined;
    }
    const summaries = reviews.flatMap((review) => {
      const summary = summaryOf(review);
      return summary ? [summary] : [];
    }).sort((left, right) => String(right.submittedAt ?? '').localeCompare(String(left.submittedAt ?? '')));
    return summaries.length > 0 ? summaries : undefined;
  },
});

export type ReviewSummaries = ReturnType<typeof createReviewSummaries>;
