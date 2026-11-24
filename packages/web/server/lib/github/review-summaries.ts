import { contextReviewFields, type ContextReviewFields } from './context-reviewers.js';
import { fieldAt } from './contracts.js';
import { isProviderString, requireProviderArray } from './mappers.js';
import type { GitHubEnvelope, Octokit } from './contracts.js';
import type { ReferenceReview } from './contracts.js';
import type { SourceControlReviewState, SourceControlReviewSummary } from '@openchamber/sdk';

export type ReferenceReviewNode = {
  databaseId?: number | null | undefined;
  state: string;
  createdAt: string | null;
  author: { login: string; avatarUrl?: string | null | undefined } | null;
};

interface ReferenceReviewStates { [state: string]: ReferenceReview['state'] | undefined }
const REVIEW_SUMMARY_STATES: ReferenceReviewStates = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', PENDING: 'pending', DISMISSED: 'dismissed',
};

export const toReferenceReviews = (nodes: ReferenceReviewNode[]): ReferenceReview[] => nodes.flatMap((review) => {
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

interface ReviewAuthor { login: string; avatarUrl?: string }

const reviewSummaryOf = (review: GitHubEnvelope['data']): SourceControlReviewSummary | null => {
  const rawState = fieldAt(review, 'state');
  const state = isProviderString(rawState) ? REVIEW_STATES[rawState] : undefined;
  const id = fieldAt(review, 'id');
  if (!state || !Number.isSafeInteger(id)) return null;
  const user = fieldAt(review, 'user');
  const login = fieldAt(user, 'login');
  const avatarUrl = fieldAt(user, 'avatar_url');
  const author: ReviewAuthor | null = isProviderString(login) ? { login } : null;
  if (author && isProviderString(avatarUrl)) author.avatarUrl = avatarUrl;
  const submittedAt = fieldAt(review, 'submitted_at');
  return { id: String(id), state, author, submittedAt: isProviderString(submittedAt) ? submittedAt : null };
};

export type { ContextReviewFields } from './context-reviewers.js';

export async function readReviewSummaries(
  octokit: Octokit, route: { owner: string; repo: string }, number: number,
): Promise<SourceControlReviewSummary[]> {
  const reviews = requireProviderArray(
    (await octokit.rest.pulls.listReviews({ ...route, pull_number: number, per_page: 100 }))?.data,
    'GitHub returned an invalid review list',
  );
  return reviews.flatMap((review) => {
    const summary = reviewSummaryOf(review);
    return summary ? [summary] : [];
  }).sort(newestFirst);
}

export const readReviewContext = async (
  octokit: Octokit, route: { owner: string; repo: string }, number: number,
  requested: readonly { login?: string | undefined; avatar_url?: string | undefined }[] | undefined,
  identity: { provider: string; instance: string },
): Promise<ContextReviewFields> => contextReviewFields(await readReviewSummaries(octokit, route, number), requested, identity);
