import { mapGiteaUser } from './mappers.js';
import { isPlainObject, isString } from '../shared/guards.js';

const REVIEW_STATES = Object.freeze({
  APPROVED: 'approved', REQUEST_CHANGES: 'changes_requested', COMMENT: 'commented', PENDING: 'pending', DISMISSED: 'dismissed',
});

const reviewSummaryOf = (review, identity) => {
  if (!isPlainObject(review) || !Number.isSafeInteger(review.id)) return null;
  const state = review.dismissed === true || review.state === 'DISMISSED' ? 'dismissed' : REVIEW_STATES[review.state];
  if (!state) return null;
  const author = mapGiteaUser(review.user, identity);
  return {
    id: String(review.id),
    state,
    author: author ? { login: author.username, avatarUrl: author.avatarUrl } : null,
    submittedAt: isString(review.submitted_at) ? review.submitted_at : null,
  };
};

export const readReviewSummaries = (reviews, identity) => reviews.flatMap((review) => {
  const summary = reviewSummaryOf(review, identity);
  return summary ? [summary] : [];
}).sort((left, right) => String(right.submittedAt ?? '').localeCompare(String(left.submittedAt ?? '')));
