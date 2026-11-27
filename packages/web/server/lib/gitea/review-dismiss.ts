import { isPlainObject } from '../shared/guards.js';
import type { JsonValue } from '../shared/json-values.js';
import type { createGiteaClient } from './client.js';

type Client = ReturnType<typeof createGiteaClient>;
type DismissInput = { reviewId: string; dismissed: boolean; message?: string | undefined };

export async function dismissReview(client: Client, reviewsUrl: string, { reviewId, dismissed, message }: DismissInput) {
  const path = `${reviewsUrl}/${encodeURIComponent(reviewId)}/${dismissed ? 'dismissals' : 'undismissals'}`;
  await client.post(path, message === undefined ? {} : { message });
  return {};
}

const dismissalOf = (review: JsonValue | null, reviewId: string): boolean | undefined => {
  if (!isPlainObject(review) || !Number.isSafeInteger(review.id) || String(review.id) !== reviewId) return undefined;
  if (review.dismissed === true || review.state === 'DISMISSED') return true;
  return review.dismissed === false ? false : undefined;
};

export async function reconcileReviewDismiss(
  client: Client, reviewsUrl: string, reviewId: string, dismissed: boolean,
): Promise<{ state: string; result?: object }> {
  const review = await client.get(`${reviewsUrl}/${encodeURIComponent(reviewId)}`);
  return dismissalOf(review, reviewId) === dismissed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
}
