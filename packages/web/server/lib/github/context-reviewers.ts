import type { SourceControlReviewSummary } from '@openchamber/sdk';

type Identity = { provider: string; instance: string };
type RequestedReviewer = { login?: string | undefined; avatar_url?: string | undefined };
type ReviewerStateValue = 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export type ContextReviewer = { provider: string; instance: string; id: string; username: string; avatarUrl?: string };
export type ContextReviewerState = { user: ContextReviewer; state: ReviewerStateValue };
export type ContextReviewFields = {
  reviews?: SourceControlReviewSummary[];
  reviewers: ContextReviewer[];
  reviewerStates?: ContextReviewerState[];
};

const REVIEWER_STATES = new Map<string, ReviewerStateValue>([
  ['approved', 'approved'], ['changes_requested', 'changes_requested'], ['commented', 'commented'], ['dismissed', 'pending'],
]);

const reviewerOf = (login: string, avatarUrl: string | undefined, identity: Identity): ContextReviewer => {
  const reviewer: ContextReviewer = { ...identity, id: login, username: login };
  if (avatarUrl) reviewer.avatarUrl = avatarUrl;
  return reviewer;
};

const requestedOf = (reviewer: RequestedReviewer, identity: Identity) => (reviewer.login
  ? reviewerOf(reviewer.login, reviewer.avatar_url || undefined, identity)
  : null);

type Opinion = 'approved' | 'changes_requested';
type ReviewTrack = { user: ContextReviewer; opinion?: Opinion | undefined; latest: ReviewerStateValue };

const opinionOf = (state: string): Opinion | undefined => (state === 'approved' || state === 'changes_requested' ? state : undefined);

export const contextReviewFields = (
  reviews: SourceControlReviewSummary[],
  requested: readonly RequestedReviewer[] | undefined,
  identity: Identity,
): ContextReviewFields => {
  const reviewers = (requested ?? []).flatMap((reviewer) => {
    const mapped = requestedOf(reviewer, identity);
    return mapped ? [mapped] : [];
  });
  const tracked = new Map<string, ReviewTrack>();
  const ordered = [...reviews].sort((left, right) => (Date.parse(left.submittedAt ?? '') || 0) - (Date.parse(right.submittedAt ?? '') || 0));
  for (const review of ordered) {
    const login = review.author?.login;
    const latest = REVIEWER_STATES.get(review.state);
    if (!login || !latest) continue;
    const track = tracked.get(login) ?? { user: reviewerOf(login, review.author?.avatarUrl, identity), latest };
    track.user = reviewerOf(login, review.author?.avatarUrl ?? track.user.avatarUrl, identity);
    track.latest = latest;
    if (review.state === 'dismissed') track.opinion = undefined;
    else track.opinion = opinionOf(review.state) ?? track.opinion;
    tracked.set(login, track);
  }
  const states = new Map<string, ContextReviewerState>();
  for (const [login, track] of tracked) states.set(login, { user: track.user, state: track.opinion ?? track.latest });
  for (const reviewer of reviewers) {
    if (!states.has(reviewer.id)) states.set(reviewer.id, { user: reviewer, state: 'pending' });
  }
  return { reviews, reviewers, reviewerStates: [...states.values()] };
};
