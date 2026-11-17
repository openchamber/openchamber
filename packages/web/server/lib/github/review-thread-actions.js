import { invalidProviderPayload, isProviderString } from './mappers.js';

const REVIEW_THREAD_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread { isResolved pullRequest { number repository { name owner { login } } } }
  }
}`;

export async function readReviewThread(octokit, threadId, project, number, mutationError) {
  let data;
  try {
    data = await octokit.graphql(REVIEW_THREAD_QUERY, { id: threadId });
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error;
    data = error.data;
  }
  const node = data?.node;
  const repository = node?.pullRequest?.repository;
  if (node?.__typename !== 'PullRequestReviewThread' || node.pullRequest.number !== number
    || !isProviderString(repository?.owner?.login) || !isProviderString(repository?.name)
    || repository.owner.login.toLowerCase() !== project.owner.toLowerCase()
    || repository.name.toLowerCase() !== project.name.toLowerCase()) {
    throw mutationError('Review thread is not on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  }
  return node;
}

export async function replyToReviewThread(octokit, threadId, body, graphqlRejection) {
  let data;
  try {
    data = await octokit.graphql(
      'mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }',
      { threadId, body },
    );
  } catch (error) {
    throw graphqlRejection(error);
  }
  if (!isProviderString(data?.addPullRequestReviewThreadReply?.comment?.id)) throw invalidProviderPayload('GitHub returned an invalid reply');
  return {};
}

export async function setReviewThreadResolved(octokit, threadId, resolved, graphqlRejection) {
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  let data;
  try {
    data = await octokit.graphql(`mutation($threadId: ID!) { ${field}(input: { threadId: $threadId }) { thread { isResolved } } }`, { threadId });
  } catch (error) {
    throw graphqlRejection(error);
  }
  if (data?.[field]?.thread?.isResolved !== resolved) throw invalidProviderPayload('GitHub returned an invalid thread state');
  return {};
}
