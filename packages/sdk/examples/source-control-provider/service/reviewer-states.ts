import type {
  SourceControlChangeRequestContext, SourceControlJsonObject, SourceControlMutationResult, SourceControlReconcileData,
  SourceControlReviewerState, SourceControlReviewState, SourceControlReviewSummary,
} from '@openchamber/sdk';

export type GiteaPerson = { id: number; login: string; avatar_url?: string };

export type GiteaReview = {
  id?: number;
  user?: GiteaPerson;
  submitted_at?: string;
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
    // Gitea pages before it hides other users' pending reviews, so a short page alone does not end the list.
    if (data.length === 0 && (total === null || page * limit >= total)) return reviews;
    if (page === 1 && data.length === total) return reviews;
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

const SUMMARY_STATE = new Map<string, SourceControlReviewState>([
  ['APPROVED', 'approved'],
  ['REQUEST_CHANGES', 'changes_requested'],
  ['COMMENT', 'commented'],
  ['PENDING', 'pending'],
]);

const reviewSummaries = (reviews: GiteaReview[]): SourceControlReviewSummary[] | undefined => {
  const opinions = reviews.filter((review) => review.dismissed === true || review.state !== 'REQUEST_REVIEW');
  const summaries = opinions.flatMap((review): SourceControlReviewSummary[] => {
    const state = review.dismissed === true ? 'dismissed' : SUMMARY_STATE.get(review.state);
    if (!Number.isSafeInteger(review.id) || !state) return [];
    const author: SourceControlReviewSummary['author'] = review.user ? { login: review.user.login } : null;
    if (author && review.user?.avatar_url) author.avatarUrl = review.user.avatar_url;
    return [{ id: String(review.id), state, author, submittedAt: review.submitted_at ?? null }];
  });
  if (summaries.length === 0 && opinions.length > 0) return undefined;
  return summaries.sort((left, right) => String(right.submittedAt ?? '').localeCompare(String(left.submittedAt ?? '')));
};

type ForgeApi<Call> = <T>(call: Call, method: 'GET' | 'POST', path: string, options?: { body?: SourceControlJsonObject }) => Promise<{ data: T }>;
type Refusal = new (message: string, status: number, code?: string) => Error;
type PullTarget = { owner: string; name: string; number?: number | undefined };
type ReviewRecord = { id: number; dismissed?: boolean };
type DismissInput = { reviewId?: unknown; dismissed?: unknown; message?: unknown };

const DISMISS_KIND = 'change-request-review-dismiss';

export const reviewDismissal = <Call>(api: ForgeApi<Call>, Refused: Refusal) => {
  const reviewPath = (target: PullTarget, reviewId: string) => (
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/pulls/${target.number ?? 0}/reviews/${encodeURIComponent(reviewId)}`
  );
  const readReview = async (call: Call, target: PullTarget, reviewId: string): Promise<ReviewRecord> => {
    try {
      const { data } = await api<ReviewRecord>(call, 'GET', reviewPath(target, reviewId));
      if (String(data.id) === reviewId) return data;
    } catch (error) {
      if (Object(error).status !== 404) throw error;
    }
    throw new Refused('The review is not on this pull request', 409, 'SOURCE_CONTROL_MUTATION_TARGET_INVALID');
  };
  return {
    perform: async (call: Call, kind: string, input: DismissInput, target: PullTarget): Promise<SourceControlMutationResult> => {
      if (kind !== DISMISS_KIND) throw new Refused(`${kind} is not something this Git host offers`, 501, 'UNSUPPORTED');
      const reviewId = String(input.reviewId ?? '');
      await readReview(call, target, reviewId);
      const dismissed = input.dismissed !== false;
      const body: SourceControlJsonObject = dismissed ? { message: String(input.message ?? '') } : {};
      await api(call, 'POST', `${reviewPath(target, reviewId)}/${dismissed ? 'dismissals' : 'undismissals'}`, { body });
      return {};
    },
    reconcile: async (call: Call, kind: string, input: DismissInput, target: PullTarget): Promise<SourceControlReconcileData> => {
      if (kind !== DISMISS_KIND) return { state: 'outcome-unknown' };
      const review = await readReview(call, target, String(input.reviewId ?? ''));
      return typeof review.dismissed === 'boolean' && review.dismissed === (input.dismissed !== false)
        ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },
  };
};

export type ReviewerStatesApi = {
  readReviews: typeof readReviews;
  reviewDismissal: typeof reviewDismissal;
  withReviewerStates: <T extends object>(
    context: T, reviews: GiteaReview[] | null, requested: GiteaPerson[], canDismissReviews: boolean,
  ) => T & SourceControlChangeRequestContext;
};

export const withReviewerStates = <T extends object>(
  context: T,
  reviews: GiteaReview[] | null,
  requested: GiteaPerson[],
  canDismissReviews: boolean,
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
  const summaries = reviewSummaries(reviews);
  const withReviews = summaries === undefined ? { ...context, canDismissReviews } : { ...context, reviews: summaries, canDismissReviews };
  return latest.size === 0 ? withReviews : { ...withReviews, reviewerStates: [...latest.values()] };
};
