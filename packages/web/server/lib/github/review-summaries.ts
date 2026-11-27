import { z } from 'zod';
import { contextReviewFields, type ContextReviewFields } from './context-reviewers.js';
import type { Octokit } from './contracts.js';
import { toReviewers, toReviewerStates, type GitHubReviewerState } from './reviewer-states.js';
import type { ReferenceReview } from './contracts.js';
import type { SourceControlReviewState, SourceControlReviewSummary } from '@openchamber/sdk';

type ReferenceReviewNode = {
  databaseId?: number | null | undefined;
  state: string;
  createdAt: string | null;
  author: { login: string; avatarUrl?: string | null | undefined } | null;
};

interface ReferenceReviewStates { [state: string]: ReferenceReview['state'] | undefined }
const REVIEW_SUMMARY_STATES: ReferenceReviewStates = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', PENDING: 'pending', DISMISSED: 'dismissed',
};

const toReferenceReviews = (nodes: ReferenceReviewNode[]): ReferenceReview[] => nodes.flatMap((review) => {
  const state = REVIEW_SUMMARY_STATES[review.state];
  if (!state) return [];
  const summary: ReferenceReview = {
    state,
    author: review.author ? { login: review.author.login, avatarUrl: review.author.avatarUrl ?? undefined } : null,
    submittedAt: review.createdAt ?? null,
  };
  if (Number.isSafeInteger(review.databaseId)) summary.id = String(review.databaseId);
  return [summary];
}).sort((left, right) => (Date.parse(right.submittedAt ?? '') || 0) - (Date.parse(left.submittedAt ?? '') || 0));

interface ReviewStates { [state: string]: SourceControlReviewState | undefined }
const REVIEW_STATES: ReviewStates = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', PENDING: 'pending', DISMISSED: 'dismissed',
};

const newestFirst = (left: SourceControlReviewSummary, right: SourceControlReviewSummary) =>
  (Date.parse(right.submittedAt ?? '') || 0) - (Date.parse(left.submittedAt ?? '') || 0);

export type { ContextReviewFields } from './context-reviewers.js';

const REVIEW_PAGE_SIZE = 100;
const REVIEW_FIELDS = 'databaseId author { login avatarUrl } body state createdAt url';
const REFERENCE_REVIEWS_QUERY = `
query ReferenceReviews($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: ${REVIEW_PAGE_SIZE}) { nodes { ${REVIEW_FIELDS} } }
      latestOpinionatedReviews(first: ${REVIEW_PAGE_SIZE}) { pageInfo { hasNextPage } nodes { ${REVIEW_FIELDS} } }
      latestReviews(first: ${REVIEW_PAGE_SIZE}) { pageInfo { hasNextPage } nodes { ${REVIEW_FIELDS} } }
    }
  }
}`;
const reviewAuthorSchema = z.object({ login: z.string(), avatarUrl: z.string().nullable().optional() }).nullable();
const reviewNodeSchema = z.object({
  databaseId: z.number().int().nullish(),
  author: reviewAuthorSchema,
  body: z.string(),
  state: z.string(),
  createdAt: z.string().nullable(),
  url: z.string(),
});
const reviewConnectionSchema = z.object({
  nodes: z.array(z.unknown()),
});
const perUserConnectionSchema = reviewConnectionSchema.extend({
  pageInfo: z.object({ hasNextPage: z.boolean() }),
});
const reviewsAnswerSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviews: reviewConnectionSchema,
      latestOpinionatedReviews: perUserConnectionSchema,
      latestReviews: perUserConnectionSchema,
    }).nullish(),
  }).nullish(),
});

type ReviewNode = z.infer<typeof reviewNodeSchema>;

const reviewNodesOf = (nodes: unknown[]): ReviewNode[] => nodes.flatMap((node) => {
  const entry = reviewNodeSchema.safeParse(node);
  return entry.success && REVIEW_STATES[entry.data.state] ? [entry.data] : [];
});

const mergedReviewNodes = (...groups: Array<ReviewNode[] | undefined>): ReviewNode[] => {
  const merged = new Map<string, ReviewNode>();
  let unkeyed = 0;
  for (const group of groups) for (const node of group ?? []) {
    const key = Number.isSafeInteger(node.databaseId) ? `id:${node.databaseId}` : `unkeyed:${unkeyed++}`;
    if (!merged.has(key)) merged.set(key, node);
  }
  return [...merged.values()].sort((left, right) => (Date.parse(right.createdAt ?? '') || 0) - (Date.parse(left.createdAt ?? '') || 0));
};

export const readReferenceReviews = async (octokit: Octokit, owner: string, repo: string, number: number): Promise<ReviewNode[] | undefined> => {
  const parsed = reviewsAnswerSchema.parse(await octokit.graphql(REFERENCE_REVIEWS_QUERY, { owner, repo, number }));
  const pull = parsed.repository?.pullRequest;
  if (!pull) return undefined;
  const { reviews, latestOpinionatedReviews: opinions, latestReviews: latest } = pull;
  if (opinions.pageInfo.hasNextPage || latest.pageInfo.hasNextPage) return undefined;
  const nodes = mergedReviewNodes(reviewNodesOf(reviews.nodes), reviewNodesOf(opinions.nodes), reviewNodesOf(latest.nodes));
  const answered = reviews.nodes.length + opinions.nodes.length + latest.nodes.length;
  return nodes.length === 0 && answered > 0 ? undefined : nodes;
};

const reviewSummaryOf = (review: ReviewNode): SourceControlReviewSummary | null => {
  const state = REVIEW_STATES[review.state];
  if (!state || !Number.isSafeInteger(review.databaseId)) return null;
  const author: { login: string; avatarUrl?: string } | null = review.author ? { login: review.author.login } : null;
  if (author && review.author?.avatarUrl != null) author.avatarUrl = review.author.avatarUrl;
  return { id: String(review.databaseId), state, author, submittedAt: review.createdAt };
};

async function readReviewSummaries(
  octokit: Octokit, route: { owner: string; repo: string }, number: number,
): Promise<SourceControlReviewSummary[] | undefined> {
  const nodes = await readReferenceReviews(octokit, route.owner, route.repo, number);
  if (nodes === undefined) return undefined;
  const summaries = nodes.flatMap((review) => {
    const summary = reviewSummaryOf(review);
    return summary ? [summary] : [];
  }).sort(newestFirst);
  return summaries.length === 0 && nodes.length > 0 ? undefined : summaries;
}

export const readReviewContext = async (
  octokit: Octokit, route: { owner: string; repo: string }, number: number,
  requested: readonly { login?: string | undefined; avatar_url?: string | undefined }[] | undefined,
  identity: { provider: string; instance: string },
): Promise<ContextReviewFields> => {
  const reviews = await readReviewSummaries(octokit, route, number).catch(() => undefined);
  const context = contextReviewFields(reviews ?? [], requested, identity);
  return reviews === undefined ? { reviewers: context.reviewers } : context;
};

// external: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/dismissing-a-pull-request-review Dismissing a review takes write access, which Triage does not give.
const REVIEW_DISMISS_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

type ReviewRequests = Parameters<typeof toReviewers>[0];
type PullReviewSurface = {
  reviewers: ReturnType<typeof toReviewers>;
  reviews?: ReferenceReview[];
  reviewerStates?: GitHubReviewerState[];
  canDismissReviews?: boolean;
};

export const readPullReviewSurface = async (
  rosterRead: Promise<ReviewNode[] | undefined>, requests: ReviewRequests,
  viewer: { permission: string | null | undefined; state: string },
): Promise<PullReviewSurface> => {
  const roster = await rosterRead.catch(() => undefined);
  const surface: PullReviewSurface = { reviewers: toReviewers(requests) };
  if (roster) {
    surface.reviews = toReferenceReviews(roster);
    surface.reviewerStates = toReviewerStates(roster, requests);
  }
  if (viewer.permission != null) surface.canDismissReviews = REVIEW_DISMISS_PERMISSIONS.has(viewer.permission) && viewer.state === 'OPEN';
  return surface;
};
