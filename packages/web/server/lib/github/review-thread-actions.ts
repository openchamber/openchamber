import { invalidProviderPayload, isProviderString } from './mappers.js';
import { fieldAt, gqlPath, requireField } from './contracts.js';
import type { Octokit } from './contracts.js';

type Project = { owner: string; name: string };
type MutationError = (message: string, code?: string, status?: number) => Error;

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

const REVIEW_THREAD_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread { isResolved pullRequest { number repository { name owner { login } } } }
  }
}`;

export async function readReviewThread(octokit: Octokit, threadId: string, project: Project, number: number, mutationError: MutationError) {
  let data: unknown;
  try {
    data = await octokit.graphql(REVIEW_THREAD_QUERY, { id: threadId });
  } catch (cause) {
    const errors = fieldAt(cause, 'errors');
    if (!isArray(errors)) throw cause;
    data = fieldAt(cause, 'data');
  }
  const node = fieldAt(data, 'node');
  const pull = fieldAt(node, 'pullRequest');
  const repository = fieldAt(pull, 'repository');
  const login = gqlPath(repository, 'owner', 'login');
  const name = fieldAt(repository, 'name');
  if (fieldAt(node, '__typename') !== 'PullRequestReviewThread' || fieldAt(requireField(pull, 'pullRequest'), 'number') !== number
    || !isProviderString(login) || !isProviderString(name)
    || login.toLowerCase() !== project.owner.toLowerCase()
    || name.toLowerCase() !== project.name.toLowerCase()) {
    throw mutationError('Review thread is not on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  }
  return { isResolved: fieldAt(node, 'isResolved') };
}

export async function replyToReviewThread<Rejection>(
  octokit: Octokit, threadId: string, body: string, graphqlRejection: (cause: unknown) => Rejection,
) {
  let data: unknown;
  try {
    data = await octokit.graphql(
      'mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }',
      { threadId, body },
    );
  } catch (cause) {
    throw graphqlRejection(cause);
  }
  if (!isProviderString(gqlPath(data, 'addPullRequestReviewThreadReply', 'comment', 'id'))) throw invalidProviderPayload('GitHub returned an invalid reply');
  return {};
}

export async function setReviewThreadResolved<Rejection>(
  octokit: Octokit, threadId: string, resolved: boolean, graphqlRejection: (cause: unknown) => Rejection,
) {
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  let data: unknown;
  try {
    data = await octokit.graphql(`mutation($threadId: ID!) { ${field}(input: { threadId: $threadId }) { thread { isResolved } } }`, { threadId });
  } catch (cause) {
    throw graphqlRejection(cause);
  }
  if (gqlPath(data, field, 'thread', 'isResolved') !== resolved) throw invalidProviderPayload('GitHub returned an invalid thread state');
  return {};
}
