import type { SourceControlChangeRequestContext, SourceControlReviewerState } from '@openchamber/sdk';

export type GiteaPerson = { id: number; login: string; avatar_url?: string };

export type GiteaReview = {
  user?: GiteaPerson;
  state: string;
  stale?: boolean;
  dismissed?: boolean;
};

type ReviewPage = { data: GiteaReview[]; total: number | null };
type ReadReviewPage = (page: number, limit: number) => Promise<ReviewPage>;
const REVIEW_SCAN_PAGES = 10;
// Keep this optional read inside the host's 20-second deadline.
const REVIEW_BUDGET_MS = 8_000;

const scanReviews = async (limit: number, readPage: ReadReviewPage, expired: () => boolean): Promise<GiteaReview[] | null> => {
  const reviews: GiteaReview[] = [];
  for (let page = 1; page <= REVIEW_SCAN_PAGES; page += 1) {
    const { data, total } = await readPage(page, limit);
    if (expired() || !Array.isArray(data)) return null;
    reviews.push(...data);
    if (data.length < limit || (total !== null && reviews.length >= total)) return reviews;
  }
  return null;
};

export const readReviews = async (limit: number, readPage: ReadReviewPage, budgetMs = REVIEW_BUDGET_MS): Promise<GiteaReview[] | null> => {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { expired = true; resolve(null); }, budgetMs);
  });
  try {
    return await Promise.race([scanReviews(limit, readPage, () => expired), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const STATE = new Map<string, SourceControlReviewerState['state']>([
  ['APPROVED', 'approved'],
  ['REQUEST_CHANGES', 'changes_requested'],
  ['COMMENT', 'commented'],
]);

const stateOf = (state: string): SourceControlReviewerState['state'] | null => STATE.get(state) ?? null;

const person = (user: GiteaPerson): SourceControlReviewerState['user'] => {
  const mapped: SourceControlReviewerState['user'] = { id: String(user.id), username: user.login };
  if (user.avatar_url) mapped.avatarUrl = user.avatar_url;
  return mapped;
};

export type ReviewerStatesApi = {
  readReviews: typeof readReviews;
  withReviewerStates: <T extends object>(context: T, reviews: GiteaReview[] | null, requested: GiteaPerson[]) => T & SourceControlChangeRequestContext;
};

export const withReviewerStates = <T extends object>(
  context: T,
  reviews: GiteaReview[] | null,
  requested: GiteaPerson[],
): T & SourceControlChangeRequestContext => {
  if (!reviews) return context;
  const latest = new Map<string, SourceControlReviewerState>();
  for (const review of reviews) {
    // A dismissed review no longer counts, whatever state it gave: the reviewer
    // owes a new one, as the built-in Gitea adapter reads it.
    const state = review.dismissed === true ? 'pending' : stateOf(review.state);
    if (review.user && state) latest.set(String(review.user.id), { user: person(review.user), state });
  }
  for (const user of requested) {
    if (!latest.has(String(user.id))) latest.set(String(user.id), { user: person(user), state: 'pending' });
  }
  return latest.size === 0 ? context : { ...context, reviewerStates: [...latest.values()] };
};
