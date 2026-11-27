type GitHubUser = { login: string; avatarUrl?: string | null | undefined };

type ReviewRequest = {
  requestedReviewer: { __typename: string; login?: string | undefined; avatarUrl?: string | null | undefined } | null;
};

type ReviewNode = { author: GitHubUser | null; state: string; createdAt?: string | null | undefined };

export type GitHubReviewerState = {
  id: string;
  login: string;
  avatarUrl?: string | undefined;
  state: 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
};

const toAuthor = (author: GitHubUser | null | undefined) => (author ? { login: author.login, avatarUrl: author.avatarUrl ?? undefined } : null);

export const toReviewers = (reviewRequests: ReviewRequest[]) => reviewRequests.flatMap(({ requestedReviewer: reviewer }) => {
  if (reviewer?.__typename !== 'User' || !reviewer.login) return [];
  const login = reviewer.login;
  return [{ id: login, ...toAuthor({ login, avatarUrl: reviewer.avatarUrl }) }];
});

const REVIEWER_STATES = new Map<string, GitHubReviewerState['state']>([
  ['APPROVED', 'approved'],
  ['CHANGES_REQUESTED', 'changes_requested'],
  ['COMMENTED', 'commented'],
  ['DISMISSED', 'pending'],
]);

type Opinion = 'approved' | 'changes_requested';
type ReviewTrack = { login: string; avatarUrl?: string | undefined; opinion?: Opinion | undefined; latest: GitHubReviewerState['state'] };

const opinionOf = (state: string): Opinion | undefined => (
  state === 'APPROVED' ? 'approved' : state === 'CHANGES_REQUESTED' ? 'changes_requested' : undefined
);

export const toReviewerStates = (reviews: ReviewNode[], reviewRequests: ReviewRequest[]): GitHubReviewerState[] => {
  const tracked = new Map<string, ReviewTrack>();
  const created = (review: ReviewNode) => Date.parse(review.createdAt ?? '') || 0;
  for (const review of [...reviews].sort((left, right) => created(left) - created(right))) {
    const login = review.author?.login;
    const latest = REVIEWER_STATES.get(review.state);
    if (!login || !latest) continue;
    const track = tracked.get(login) ?? { login, latest };
    track.avatarUrl = review.author?.avatarUrl ?? track.avatarUrl;
    track.latest = latest;
    if (review.state === 'DISMISSED') track.opinion = undefined;
    else track.opinion = opinionOf(review.state) ?? track.opinion;
    tracked.set(login, track);
  }
  const states = new Map<string, GitHubReviewerState>();
  for (const [login, track] of tracked) {
    states.set(login, { id: login, login, avatarUrl: track.avatarUrl, state: track.opinion ?? track.latest });
  }
  for (const { requestedReviewer: reviewer } of reviewRequests) {
    if (reviewer?.__typename !== 'User' || !reviewer.login || states.has(reviewer.login)) continue;
    states.set(reviewer.login, {
      id: reviewer.login, login: reviewer.login, avatarUrl: reviewer.avatarUrl ?? undefined, state: 'pending',
    });
  }
  return [...states.values()];
};
