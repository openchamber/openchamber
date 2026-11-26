import { isPlainObject, isString } from '../shared/guards.js';
import { dismissReview, reconcileReviewDismiss } from './review-dismiss.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { GiteaIdentity } from './mappers.js';
import { mapGiteaReviewerStates, mapGiteaUser, mapGiteaVerdict } from './mappers.js';
import type { createGiteaClient } from './client.js';
import type { SourceControlReviewState, SourceControlReviewSummary } from '@openchamber/sdk';

interface ReviewStates { [state: string]: SourceControlReviewState | undefined }
const REVIEW_STATES: ReviewStates = {
  APPROVED: 'approved', REQUEST_CHANGES: 'changes_requested', COMMENT: 'commented', PENDING: 'pending', DISMISSED: 'dismissed',
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject => isPlainObject(value);

interface ReviewAuthor { login: string; avatarUrl?: string }

const REQUEST_REVIEW = 'REQUEST_REVIEW';

const reviewSummaryOf = (review: JsonValue | undefined, identity: GiteaIdentity): SourceControlReviewSummary | 'skipped' | null => {
  if (!isJsonObject(review)) return null;
  const id = review.id;
  if (!Number.isSafeInteger(id)) return null;
  const rawState = review.state;
  if (rawState === REQUEST_REVIEW && review.dismissed !== true) return 'skipped';
  const state = review.dismissed === true || rawState === 'DISMISSED'
    ? 'dismissed'
    : isString(rawState) ? REVIEW_STATES[rawState] : undefined;
  if (!state) return null;
  const author = mapGiteaUser(review.user, identity);
  const submittedAt = review.submitted_at;
  const summaryAuthor: ReviewAuthor | null = author ? { login: author.username } : null;
  if (summaryAuthor && author?.avatarUrl !== undefined) summaryAuthor.avatarUrl = author.avatarUrl;
  return {
    id: String(id),
    state,
    author: summaryAuthor,
    submittedAt: isString(submittedAt) ? submittedAt : null,
  };
};

const readReviewSummaries = (reviews: JsonValue[], identity: GiteaIdentity): SourceControlReviewSummary[] | undefined => {
  let malformed = false;
  const summaries = reviews.flatMap((review) => {
    const summary = reviewSummaryOf(review, identity);
    if (summary === null) malformed = true;
    return summary && summary !== 'skipped' ? [summary] : [];
  });
  if (summaries.length === 0 && malformed) return undefined;
  return summaries.sort((left, right) => String(right.submittedAt ?? '').localeCompare(String(left.submittedAt ?? '')));
};

export const readReviewContext = (reviews: JsonValue[], requested: JsonValue | undefined, identity: GiteaIdentity, fallbackUrl: string) => {
  const summaries = readReviewSummaries(reviews, identity);
  const fields = {
    reviewers: (Array.isArray(requested) ? requested : []).flatMap((user) => {
      const mapped = mapGiteaUser(user, identity);
      return mapped ? [mapped] : [];
    }),
    verdicts: reviews.flatMap((review) => {
      const mapped = mapGiteaVerdict(review, identity, fallbackUrl);
      return mapped ? [mapped] : [];
    }),
  };
  if (summaries === undefined) return fields;
  return { ...fields, reviews: summaries, reviewerStates: mapGiteaReviewerStates(reviews, requested, identity) };
};

export const canDismissReviews = (repository: JsonValue | undefined, state: string) => {
  const admin = isJsonObject(repository) && isJsonObject(repository.permissions) ? repository.permissions.admin : undefined;
  return admin === true || admin === false ? admin && state === 'open' : undefined;
};

type Client = ReturnType<typeof createGiteaClient>;

export const giteaReviewMethods = <Target extends { number: number }>(client: Client, reviewsPath: (target: Target) => string) => ({
  dismissReview: (payload: { providerTarget: Target; reviewId: string; dismissed: boolean; message?: string | undefined }) =>
    dismissReview(client, reviewsPath(payload.providerTarget), payload),
  reconcileReviewDismiss: (providerTarget: Target, reviewId: string, dismissed: boolean) =>
    reconcileReviewDismiss(client, reviewsPath(providerTarget), reviewId, dismissed),
});
