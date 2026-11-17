import { isPlainObject, isProviderString } from './mappers.js';

const REVIEW_STATE_QUERY = 'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(last: 100) { nodes { databaseId state } } } } }';
const REVIEW_ID_RE = /^[1-9]\d{0,15}$/;

export function normalizeReviewDismiss(body, digestOf, limits, mutationError) {
  const reviewId = isProviderString(body.reviewId) || Number.isSafeInteger(body.reviewId) ? String(body.reviewId).trim() : '';
  if (!REVIEW_ID_RE.test(reviewId)) throw mutationError('reviewId is invalid');
  if (body.dismissed === false || (body.dismissed !== undefined && body.dismissed !== true)) throw mutationError('GitHub reviews cannot be undismissed');
  if (!isProviderString(body.message) || !body.message.trim()) throw mutationError('body is required');
  if (body.message.length > limits.commentMaxLength) throw mutationError('body is too long');
  const message = body.message;
  return { input: { reviewId: Number(reviewId), message }, digest: (target) => digestOf({ target, reviewId: Number(reviewId), message }) };
}

export async function resolveReviewDismiss(octokit, project, number, reviewId, mutationError) {
  let review;
  try {
    review = (await octokit.rest.pulls.getReview({
      owner: project.owner, repo: project.name, pull_number: number, review_id: reviewId,
    }))?.data;
  } catch (error) {
    const status = error?.response?.status ?? error?.status;
    if (status === 404) throw mutationError('Review is not on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    throw error;
  }
  if (!isPlainObject(review) || review.id !== reviewId) {
    throw mutationError('Review is not on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  }
}

export async function performReviewDismiss(octokit, project, number, reviewId, message) {
  await octokit.rest.pulls.dismissReview({
    owner: project.owner, repo: project.name, pull_number: number, review_id: reviewId, message,
  });
  return {};
}

export async function reconcileReviewDismiss(octokit, project, number, reviewId) {
  const data = await octokit.graphql(REVIEW_STATE_QUERY, { owner: project.owner, name: project.name, number });
  const nodes = data?.repository?.pullRequest?.reviews?.nodes;
  if (!Array.isArray(nodes)) return { state: 'outcome-unknown' };
  const review = nodes.find((node) => node?.databaseId === reviewId);
  return isProviderString(review?.state) && review.state === 'DISMISSED'
    ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
}
