import { isPlainObject, isProviderString, requireProviderArray } from './mappers.js';

const REVIEW_STATES = Object.freeze({
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', PENDING: 'pending', DISMISSED: 'dismissed',
});

const newestFirst = (left, right) => (Date.parse(right.submittedAt ?? '') || 0) - (Date.parse(left.submittedAt ?? '') || 0);

const reviewSummaryOf = (review) => {
  const state = isPlainObject(review) ? REVIEW_STATES[review.state] : null;
  if (!state || !Number.isSafeInteger(review.id)) return null;
  const author = isPlainObject(review.user) && isProviderString(review.user.login)
    ? { login: review.user.login, avatarUrl: review.user.avatar_url ?? undefined }
    : null;
  return { id: String(review.id), state, author, submittedAt: review.submitted_at ?? null };
};

export async function readReviewSummaries(octokit, route, number) {
  const reviews = requireProviderArray(
    (await octokit.rest.pulls.listReviews({ ...route, pull_number: number, per_page: 100 }))?.data,
    'GitHub returned an invalid review list',
  );
  return reviews.flatMap((review) => {
    const summary = reviewSummaryOf(review);
    return summary ? [summary] : [];
  }).sort(newestFirst);
}
