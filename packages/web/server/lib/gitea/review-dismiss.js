import { isPlainObject, isString } from '../shared/guards.js';

export async function dismissReview(client, reviewsUrl, { reviewId, dismissed, message }) {
  const path = `${reviewsUrl}/${encodeURIComponent(reviewId)}/${dismissed ? 'dismissals' : 'undismissals'}`;
  await client.post(path, message === undefined ? {} : { message });
  return {};
}

export async function reconcileReviewDismiss(client, reviewsUrl, reviewId, dismissed) {
  const review = await client.get(`${reviewsUrl}/${encodeURIComponent(reviewId)}`);
  if (!isPlainObject(review)) return { state: 'outcome-unknown' };
  const isDismissed = review.dismissed === true || review.state === 'DISMISSED';
  return isDismissed === dismissed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
}
