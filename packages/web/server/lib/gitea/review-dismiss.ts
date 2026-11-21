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

const dismissedIn = (review: JsonValue | null) => isPlainObject(review)
  && (review.dismissed === true || review.state === 'DISMISSED');

export async function reconcileReviewDismiss(
  client: Client, reviewsUrl: string, reviewId: string, dismissed: boolean,
): Promise<{ state: string; result?: object }> {
  const review = await client.get(`${reviewsUrl}/${encodeURIComponent(reviewId)}`);
  if (!isPlainObject(review)) return { state: 'outcome-unknown' };
  return dismissedIn(review) === dismissed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
}
