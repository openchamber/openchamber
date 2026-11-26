import { isPlainObject, isProviderString } from './mappers.js';
import { fieldAt } from './contracts.js';
import type { Octokit } from './contracts.js';
import type { SourceControlMutationTarget } from '@openchamber/sdk';
import type { MutationCompletion } from '../source-control/mutation-storage.js';

type Project = { owner: string; name: string };
type MutationError = (message: string, code?: string, status?: number) => Error;
type DismissInput = { reviewId?: string | number; dismissed?: boolean; message?: string };
type DismissDigest = { target: SourceControlMutationTarget; reviewId: number; message: string };

const REVIEW_ID_RE = /^[1-9]\d{0,15}$/;

const requestStatus = (cause: unknown) => fieldAt(fieldAt(cause, 'response'), 'status') ?? fieldAt(cause, 'status');

export function normalizeReviewDismiss(
  body: DismissInput, digestOf: (fields: DismissDigest) => string, limits: { commentMaxLength: number }, mutationError: MutationError,
) {
  const reviewId = isProviderString(body.reviewId) || Number.isSafeInteger(body.reviewId) ? String(body.reviewId).trim() : '';
  if (!REVIEW_ID_RE.test(reviewId)) throw mutationError('reviewId is invalid');
  if (body.dismissed === false || (body.dismissed !== undefined && body.dismissed !== true)) throw mutationError('GitHub reviews cannot be undismissed');
  if (!isProviderString(body.message) || !body.message.trim()) throw mutationError('body is required');
  if (body.message.length > limits.commentMaxLength) throw mutationError('body is too long');
  const message = body.message;
  const numericId = Number(reviewId);
  return { input: { reviewId: numericId, message }, digest: (target: SourceControlMutationTarget) => digestOf({ target, reviewId: numericId, message }) };
}

export async function resolveReviewDismissTarget<Target extends { number?: number | null }>(
  octokit: Octokit, project: Project, target: Target, reviewId: number, mutationError: MutationError,
) {
  const number = Number(target.number ?? Number.NaN);
  let review: unknown;
  try {
    review = (await octokit.rest.pulls.getReview({
      owner: project.owner, repo: project.name, pull_number: number, review_id: reviewId,
    }))?.data;
  } catch (cause) {
    if (requestStatus(cause) === 404) {
      throw mutationError('Review is not on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    }
    throw cause;
  }
  if (!isPlainObject(review) || fieldAt(review, 'id') !== reviewId) {
    throw mutationError('Review is not on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  }
  return { providerTarget: {}, target };
}

export async function performReviewDismiss(octokit: Octokit, project: Project, number: number, reviewId: number, message: string) {
  await octokit.rest.pulls.dismissReview({
    owner: project.owner, repo: project.name, pull_number: number, review_id: reviewId, message,
  });
  return {};
}

export async function reconcileReviewDismiss(octokit: Octokit, project: Project, number: number, reviewId: number): Promise<MutationCompletion> {
  const review = (await octokit.rest.pulls.getReview({
    owner: project.owner, repo: project.name, pull_number: number, review_id: reviewId,
  }))?.data;
  return isPlainObject(review) && fieldAt(review, 'id') === reviewId && fieldAt(review, 'state') === 'DISMISSED'
    ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
}
