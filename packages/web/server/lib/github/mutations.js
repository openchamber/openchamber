import { digestMutationInput } from '../source-control/mutation-executor.js';
import { changeRequestNetworkTarget } from '../source-control/repository-network.js';
import {
  invalidProviderPayload,
  isPlainObject,
  isProviderString,
  matchesGitHubRepositoryUrl,
  requireGitHubPullRequest,
  requireGitHubRepoNetwork,
  requireProviderArray,
} from './mappers.js';

/**
 * GitHub's durable mutations behind the shared route shell: the persisted
 * kind and digest (`prepare`), the provider target and preflight
 * (`resolveTarget`), the one provider write (`perform`) and restart
 * reconciliation (`reconcile`).
 *
 * Digests cover GitHub's short operation name (`create`, `merge`, ...) while
 * records keep `change-request-<operation>` or the issue and discussion
 * kinds; both are persisted in `source-control-mutations.json` and must stay
 * byte-identical, or a retained `running` record would replay as a conflict.
 * Discussions are written through GraphQL by their node ids, read again at
 * every write, so no id is kept in a record.
 */

const ISSUE_KINDS = new Set(['issue-comment', 'issue-state', 'issue-labels']);
const DISCUSSION_KINDS = new Set(['discussion-comment', 'discussion-state', 'discussion-answer', 'discussion-labels']);
// Issue and discussion operations are their own record kinds; the rest are a change request's.
const ownKind = (operation) => ISSUE_KINDS.has(operation) || DISCUSSION_KINDS.has(operation);
const recordKind = (operation) => (ownKind(operation) ? operation : `change-request-${operation}`);
const operationOf = (kind) => (ownKind(kind) ? kind : kind.replace(/^change-request-/, ''));
// What GitHub calls each reason a discussion is closed for.
const DISCUSSION_CLOSE_REASONS = Object.freeze({ resolved: 'RESOLVED', outdated: 'OUTDATED', duplicate: 'DUPLICATE' });

/** The route each operation answers on. */
const ROUTE_OPERATIONS = Object.freeze({
  '/pr/create': 'create',
  '/pr/update': 'update',
  '/pr/merge': 'merge',
  '/pr/ready': 'ready',
  '/pr/comment': 'comment',
  '/pr/review': 'review',
  '/pr/thread/reply': 'thread-reply',
  '/pr/thread/resolve': 'thread-resolve',
  '/issues/comment': 'issue-comment',
  '/pr/state': 'state',
  '/issues/state': 'issue-state',
  '/pr/labels': 'labels',
  '/issues/labels': 'issue-labels',
  '/pr/reviewers': 'reviewers',
  '/discussions/comment': 'discussion-comment',
  '/discussions/state': 'discussion-state',
  '/discussions/answer': 'discussion-answer',
  '/discussions/labels': 'discussion-labels',
});

const mutationError = (message, code = 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status = 400) => Object.assign(new Error(message), { code, status });
const definiteFailure = (code) => ({ state: 'failed', result: { failureStatus: 409, failureCode: code } });
const unknownOutcome = () => ({ state: 'outcome-unknown' });

const sameProject = (left, right) => left?.owner === right?.owner && left?.name === right?.name;
const sameNames = (left, right) => left.length === right.length && [...left].sort().every((entry, index) => entry === right[index]);
const repoProject = (repo) => ({ owner: repo.owner, name: repo.repo });
const pullTargetProject = (pr) => ({ owner: pr.base.repo.owner.login, name: pr.base.repo.name });
const targetMatches = (expected, pr) => pr.number === expected.number
  && (expected.head === undefined || pr.head.ref === expected.head)
  && (expected.base === undefined || pr.base.ref === expected.base)
  && (expected.headSha === undefined || pr.head.sha === expected.headSha);

/**
 * GitHub's own reason for refusing a write (a locked conversation, a review
 * of your own pull request, a merge blocked by branch protection, an
 * organization restricting OAuth apps) is what the user needs to read; the
 * generic mutation error would hide it.
 */
const providerRejection = (error) => {
  const status = error?.response?.status ?? error?.status;
  if (![403, 404, 405, 409, 422].includes(status)) return error;
  const data = error?.response?.data;
  const first = Array.isArray(data?.errors) ? data.errors[0] : undefined;
  const detail = [first, first?.message, data?.message].find((value) => isProviderString(value) && value.trim());
  return mutationError(detail ?? 'GitHub refused the change', 'SOURCE_CONTROL_MUTATION_REJECTED', status);
};

// A GraphQL write GitHub refused answers with errors, not a status: that is
// a definite refusal with GitHub's own reason.
const graphqlRejection = (error) => {
  const message = Array.isArray(error?.errors) ? error.errors.find((entry) => isProviderString(entry?.message))?.message : undefined;
  return message ? mutationError(message, 'SOURCE_CONTROL_MUTATION_REJECTED', 422) : providerRejection(error);
};

/** A provider error the request made on its way: GitHub's reason when it refused, else as it came. */
const rejected = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    throw error?.response ? providerRejection(error) : error;
  }
};

// GitHub's own limit for a comment body.
const commentText = (value, required, maxLength) => {
  if (value === undefined && !required) return undefined;
  if (!isProviderString(value) || !value.trim()) throw mutationError('body is required');
  if (value.length > maxLength) throw mutationError('body is too long');
  return value;
};
// A GraphQL node id, such as a review thread's `PRRT_kwDOA...` or a discussion comment's `DC_kwDOA...`.
const nodeId = (value, name) => {
  if (!isProviderString(value) || !/^[A-Za-z0-9_=-]{1,200}$/.test(value)) throw mutationError(`${name} is invalid`);
  return value;
};
const reviewThreadId = (value) => nodeId(value, 'threadId');
// Labels or reviewers as one whole set, so a repeat asks for the same result.
const nameList = (value, name, limit) => {
  if (!Array.isArray(value) || value.length > limit
    || value.some((entry) => !isProviderString(entry) || !entry.trim() || entry.length > 256)) {
    throw mutationError(`${name} are invalid`);
  }
  return [...new Set(value)].sort();
};
const requiredText = (value, name) => {
  if (!isProviderString(value) || !value.trim()) throw mutationError(`${name} is required`);
  return value.trim();
};
const optionalText = (value, name, trim = false) => {
  if (value === undefined) return undefined;
  if (!isProviderString(value)) throw mutationError(`${name} is invalid`);
  const normalized = trim ? value.trim() : value;
  if (trim && !normalized) throw mutationError(`${name} is invalid`);
  return normalized;
};

/**
 * The normalized input of one operation and the digest it has always had:
 * which fields are present, and their order of addition, is the digest.
 */
function normalizeOperation(operation, body, context, actor, credential, limits) {
  const digestOf = (fields) => digestMutationInput({ kind: operation, actor, credential, ...fields });
  if (operation === 'create') {
    const title = requiredText(body.title, 'title');
    const text = optionalText(body.body, 'body');
    if (body.draft !== undefined && Object.prototype.toString.call(body.draft) !== '[object Boolean]') {
      throw mutationError('draft is invalid');
    }
    const draft = body.draft;
    const remote = optionalText(body.remote, 'remote', true);
    const headRemote = optionalText(body.headRemote, 'headRemote', true) ?? context.primaryRemote;
    const head = requiredText(context.target.head, 'target head');
    const base = requiredText(context.target.base, 'target base');
    if (context.target.number !== undefined || context.target.headSha !== undefined) throw mutationError('Create target is invalid');
    return {
      input: { title, body: text, draft, remote, headRemote, head, base },
      digest: (target) => {
        const fields = { target, title, headRemote };
        if (text !== undefined) fields.body = text;
        if (draft !== undefined) fields.draft = draft;
        if (remote) fields.remote = remote;
        return digestOf(fields);
      },
    };
  }

  if (!Number.isSafeInteger(context.target.number) || context.target.number < 1) throw mutationError('target number is required');
  if (operation === 'update') {
    const title = requiredText(body.title, 'title');
    const text = optionalText(body.body, 'body');
    return {
      input: { title, body: text },
      digest: (target) => digestOf(text === undefined ? { target, title } : { target, title, body: text }),
    };
  }
  if (operation === 'merge') {
    const method = requiredText(body.method, 'method');
    if (!['merge', 'squash', 'rebase'].includes(method)) throw mutationError('merge method is invalid');
    return { input: { method }, digest: (target) => digestOf({ target, method }) };
  }
  if (operation === 'ready') return { input: {}, digest: (target) => digestOf({ target }) };
  if (operation === 'labels' || operation === 'issue-labels' || operation === 'discussion-labels') {
    const labels = nameList(body.labels, 'labels', limits.labelsMax);
    return { input: { labels }, digest: (target) => digestOf({ target, labels }) };
  }
  if (operation === 'discussion-comment') {
    // A reply names the comment whose thread it answers; without one it is a comment of its own.
    const replyTo = body.replyTo === undefined ? undefined : nodeId(body.replyTo, 'replyTo');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return {
      input: { replyTo, body: text },
      digest: (target) => digestOf(replyTo === undefined ? { target, body: text } : { target, replyTo, body: text }),
    };
  }
  if (operation === 'discussion-state') {
    if (body.state === 'open') {
      if (body.reason !== undefined) throw mutationError('reason is invalid');
      return { input: { state: 'open' }, digest: (target) => digestOf({ target, state: 'open' }) };
    }
    if (body.state !== 'closed' || !Object.hasOwn(DISCUSSION_CLOSE_REASONS, body.reason)) throw mutationError('state is invalid');
    const { reason } = body;
    return { input: { state: 'closed', reason }, digest: (target) => digestOf({ target, state: 'closed', reason }) };
  }
  if (operation === 'discussion-answer') {
    const commentId = nodeId(body.commentId, 'commentId');
    if (body.answer !== true && body.answer !== false) throw mutationError('answer is invalid');
    const { answer } = body;
    return { input: { commentId, answer }, digest: (target) => digestOf({ target, commentId, answer }) };
  }
  if (operation === 'reviewers') {
    const reviewers = nameList(body.reviewers, 'reviewers', limits.reviewersMax);
    return { input: { reviewers }, digest: (target) => digestOf({ target, reviewers }) };
  }
  if (operation === 'state' || operation === 'issue-state') {
    if (body.state !== 'open' && body.state !== 'closed') throw mutationError('state is invalid');
    const { state } = body;
    return { input: { state }, digest: (target) => digestOf({ target, state }) };
  }
  if (operation === 'comment' || operation === 'issue-comment') {
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { body: text }, digest: (target) => digestOf({ target, body: text }) };
  }
  if (operation === 'thread-reply') {
    const threadId = reviewThreadId(body.threadId);
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { threadId, body: text }, digest: (target) => digestOf({ target, threadId, body: text }) };
  }
  if (operation === 'thread-resolve') {
    const threadId = reviewThreadId(body.threadId);
    if (body.resolved !== true && body.resolved !== false) throw mutationError('resolved is invalid');
    const { resolved } = body;
    return { input: { threadId, resolved }, digest: (target) => digestOf({ target, threadId, resolved }) };
  }
  if (operation === 'review') {
    const { verdict } = body;
    if (verdict !== 'approve' && verdict !== 'request-changes') throw mutationError('review verdict is invalid');
    // A verdict names the commit it is for; without one it would land on whatever was pushed last.
    requiredText(context.target.headSha, 'target headSha');
    // GitHub asks for the reason when changes are requested.
    const text = commentText(body.body, verdict === 'request-changes', limits.commentMaxLength);
    return {
      input: { verdict, body: text },
      digest: (target) => digestOf(text === undefined ? { target, verdict } : { target, verdict, body: text }),
    };
  }
  throw mutationError('Mutation kind is invalid');
}

/**
 * `octokitOf(session)` is the session's Octokit; `resolveRepo` and
 * `resolveNetwork` resolve the bound repository and its fork network.
 * `onSucceeded` drops caches of what a mutation changed.
 */
export function createGitHubMutations({ descriptor, octokitOf, resolveRepo, resolveNetwork, invalidatePulls, onSucceeded }) {
  // `octokit` is the client that answered: its host is where the base
  // repository has to live.
  const requireMutationPullRequest = (value, message, octokit) => {
    const pr = requireGitHubPullRequest(value, message);
    if (!isProviderString(pr.head?.sha) || !pr.head.sha.trim()
      || Object.prototype.toString.call(pr.draft) !== '[object Boolean]'
      || Object.prototype.toString.call(pr.merged) !== '[object Boolean]'
      || !isPlainObject(pr.base?.repo)
      || !isPlainObject(pr.base.repo.owner)
      || !isProviderString(pr.base.repo.owner.login) || !pr.base.repo.owner.login.trim()
      || !isProviderString(pr.base.repo.name) || !pr.base.repo.name.trim()
      || !matchesGitHubRepositoryUrl(pr.base.repo.html_url, pr.base.repo.owner.login, pr.base.repo.name, octokit?.openChamberHost || '')) {
      throw invalidProviderPayload(message);
    }
    return pr;
  };

  // GitHub keeps a chain of PRs, each on the branch of the one below, as a
  // stack when asked. A new PR whose base is another open PR's branch joins
  // that PR's stack as its top layer, or starts one with it. True once GitHub
  // keeps it, false when it refused (the parent is not its stack's top layer,
  // a host without stacks); the PR itself stands either way, on that base.
  // Undefined when the base is no open PR's branch, or that cannot be read.
  // The default branch is a stack's trunk, never a layer: a PR into it does
  // not join an open PR out of it (a release PR from main to production).
  const stackOnParent = async (octokit, project, number, base, defaultBranch) => {
    if (!defaultBranch || base === defaultBranch) return undefined;
    const route = { owner: project.owner, repo: project.name };
    let parent;
    try {
      const listed = await octokit.rest.pulls.list({ ...route, state: 'open', head: `${project.owner}:${base}`, per_page: 5 });
      parent = (Array.isArray(listed?.data) ? listed.data : [])
        .find((pr) => isPlainObject(pr) && pr.number !== number && pr.head?.ref === base
          && sameProject(pr.head?.repo ? { owner: pr.head.repo.owner?.login, name: pr.head.repo.name } : null, project));
    } catch {
      return undefined;
    }
    if (!parent) return undefined;
    try {
      const listedStacks = await octokit.request('GET /repos/{owner}/{repo}/stacks', { ...route, pull_request: parent.number });
      const stack = Array.isArray(listedStacks?.data) ? listedStacks.data[0] : null;
      if (isPlainObject(stack) && Number.isSafeInteger(stack.number)) {
        await octokit.request('POST /repos/{owner}/{repo}/stacks/{stack_number}/add', { ...route, stack_number: stack.number, pull_requests: [number] });
      } else {
        await octokit.request('POST /repos/{owner}/{repo}/stacks', { ...route, pull_requests: [parent.number, number] });
      }
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Where a PR found after an interrupted create stands: true when GitHub
   * already keeps it in a stack, else as `stackOnParent` would leave it.
   * Undefined when GitHub cannot say, so the receipt claims nothing.
   */
  const settleStack = async (octokit, project, number, base, defaultBranch) => {
    let listed;
    try {
      listed = await octokit.request('GET /repos/{owner}/{repo}/stacks', { owner: project.owner, repo: project.name, pull_request: number });
    } catch {
      return undefined;
    }
    if (!Array.isArray(listed?.data)) return undefined;
    if (listed.data.some((stack) => isPlainObject(stack) && Number.isSafeInteger(stack.number))) return true;
    return stackOnParent(octokit, project, number, base, defaultBranch);
  };

  // GitHub merges a stacked PR, with the layers below it, and enters a merge
  // queue only through its asynchronous merge; the classic endpoint refuses
  // both. The merge runs in the background, so the answer is followed for a
  // while: most land within seconds, and one still running is reported as
  // such, its outcome arriving with the PR's live state. A host without the
  // endpoint (an older GitHub Enterprise Server) merges the classic way.
  // The classic endpoint lets a ruleset's bypass actor merge past the rules
  // without asking; the asynchronous one does so only with `bypass_rules`,
  // which is sent so both merge the same way. It never widens who may bypass.
  const MERGE_ASYNC_POLL_MS = 1000;
  const MERGE_ASYNC_WAIT_MS = 20_000;
  const MERGE_ASYNC_STATUSES = new Set(['pending', 'merged', 'enqueued', 'failed']);
  const isMergeAsyncAnswer = (data) => isPlainObject(data) && MERGE_ASYNC_STATUSES.has(data.status);
  const mergeAsyncAnswer = (data) => {
    if (!isMergeAsyncAnswer(data)) throw invalidProviderPayload('GitHub returned an invalid merge result');
    const details = isPlainObject(data.details) ? data.details : {};
    return {
      status: data.status,
      uuid: isProviderString(details.uuid) ? details.uuid : null,
      message: isProviderString(details.message) ? details.message : null,
    };
  };
  const mergeClassic = async (octokit, project, target, method) => {
    const merged = await octokit.rest.pulls.merge({
      owner: project.owner, repo: project.name, pull_number: target.number, merge_method: method, sha: target.headSha,
    });
    const data = merged?.data;
    if (!isPlainObject(data) || Object.prototype.toString.call(data.merged) !== '[object Boolean]'
      || (data.message !== undefined && !isProviderString(data.message))) {
      throw invalidProviderPayload('GitHub returned an invalid merge result');
    }
    return { merged: data.merged };
  };
  const mergePullRequest = async (octokit, project, target, method) => {
    const route = { owner: project.owner, repo: project.name, pull_number: target.number };
    let answer;
    try {
      const response = await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async', {
        ...route, merge_method: method, sha: target.headSha, bypass_rules: true,
      });
      answer = mergeAsyncAnswer(response?.data);
    } catch (error) {
      const status = error?.response?.status ?? error?.status;
      if (status === 404) return mergeClassic(octokit, project, target, method);
      // A merge of this PR already requested is followed instead of asked
      // again; any other refusal (a moved head, a conflict) is GitHub's reason.
      if (status !== 409 || !isMergeAsyncAnswer(error.response?.data)) throw providerRejection(error);
      answer = mergeAsyncAnswer(error.response.data);
    }
    // Accepted from here on: a follow-up read that fails says nothing about
    // the merge itself, which the PR's live state then reports.
    const deadline = Date.now() + MERGE_ASYNC_WAIT_MS;
    while (answer.status === 'pending' && answer.uuid && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, MERGE_ASYNC_POLL_MS));
      try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}', { ...route, uuid: answer.uuid });
        answer = mergeAsyncAnswer(response?.data);
      } catch {
        return { merged: false, outcome: 'merging' };
      }
    }
    if (answer.status === 'failed') {
      throw mutationError(answer.message ?? 'GitHub could not merge the pull request', 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
    }
    if (answer.status === 'merged') return { merged: true };
    return { merged: false, outcome: answer.status === 'enqueued' ? 'queued' : 'merging' };
  };

  const postComment = async (octokit, project, number, body) => {
    const response = await rejected(() => octokit.rest.issues.createComment({ owner: project.owner, repo: project.name, issue_number: number, body }));
    if (!isPlainObject(response?.data) || !Number.isSafeInteger(response.data.id)) throw invalidProviderPayload('GitHub returned an invalid comment');
    return {};
  };

  const REVIEW_THREAD_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread { isResolved pullRequest { number repository { name owner { login } } } }
  }
}`;
  /** The review thread `threadId` names, and only one on the target pull request: an id from elsewhere is refused. */
  const readReviewThread = async (octokit, threadId, project, number) => {
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
  };
  const replyToReviewThread = async (octokit, threadId, body) => {
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
  };
  const setReviewThreadResolved = async (octokit, threadId, resolved) => {
    const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    let data;
    try {
      data = await octokit.graphql(`mutation($threadId: ID!) { ${field}(input: { threadId: $threadId }) { thread { isResolved } } }`, { threadId });
    } catch (error) {
      throw graphqlRejection(error);
    }
    if (data?.[field]?.thread?.isResolved !== resolved) throw invalidProviderPayload('GitHub returned an invalid thread state');
    return {};
  };
  // A discussion lives in GitHub's GraphQL API only: it is written by its node
  // id, and its labels by theirs.
  const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) { id number closed labels(first: 100) { nodes { id name } } }
  }
}`;
  const graphqlWrite = async (octokit, query, variables) => {
    try {
      return await octokit.graphql(query, variables);
    } catch (error) {
      throw graphqlRejection(error);
    }
  };
  const readDiscussion = async (octokit, project, number) => {
    let data;
    try {
      data = await octokit.graphql(DISCUSSION_QUERY, { owner: project.owner, name: project.name, number });
    } catch (error) {
      if (!Array.isArray(error?.errors)) throw error;
      data = error.data;
    }
    const discussion = data?.repository?.discussion;
    if (!isPlainObject(discussion) || discussion.number !== number || !isProviderString(discussion.id) || !discussion.id) {
      throw mutationError('GitHub discussion was not found', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    }
    const labels = requireProviderArray(discussion.labels?.nodes, 'GitHub returned an invalid label list');
    if (labels.some((label) => !isProviderString(label?.id) || !isProviderString(label?.name))) {
      throw invalidProviderPayload('GitHub returned an invalid label list');
    }
    return { id: discussion.id, closed: discussion.closed === true, labels };
  };
  const DISCUSSION_COMMENT_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on DiscussionComment { isAnswer replyTo { id } discussion { number repository { name owner { login } } } }
  }
}`;
  /** The comment `commentId` names, and only one of the target discussion: an id from elsewhere is refused. */
  const readDiscussionComment = async (octokit, commentId, project, number) => {
    let data;
    try {
      data = await octokit.graphql(DISCUSSION_COMMENT_QUERY, { id: commentId });
    } catch (error) {
      if (!Array.isArray(error?.errors)) throw error;
      data = error.data;
    }
    const node = data?.node;
    const repository = node?.discussion?.repository;
    if (node?.__typename !== 'DiscussionComment' || node.discussion.number !== number
      || !isProviderString(repository?.owner?.login) || !isProviderString(repository?.name)
      || repository.owner.login.toLowerCase() !== project.owner.toLowerCase()
      || repository.name.toLowerCase() !== project.name.toLowerCase()) {
      throw mutationError('Comment is not on this discussion', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    }
    return { isAnswer: node.isAnswer === true, reply: isPlainObject(node.replyTo) };
  };
  const commentOnDiscussion = async (octokit, discussionId, body, replyTo) => {
    const data = await graphqlWrite(
      octokit,
      'mutation($discussionId: ID!, $body: String!, $replyToId: ID) { addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) { comment { id } } }',
      { discussionId, body, replyToId: replyTo ?? null },
    );
    if (!isProviderString(data?.addDiscussionComment?.comment?.id)) throw invalidProviderPayload('GitHub returned an invalid comment');
    return {};
  };
  const setDiscussionState = async (octokit, discussionId, state, reason) => {
    const data = state === 'closed'
      ? await graphqlWrite(
        octokit,
        'mutation($discussionId: ID!, $reason: DiscussionCloseReason!) { closeDiscussion(input: { discussionId: $discussionId, reason: $reason }) { discussion { closed } } }',
        { discussionId, reason: DISCUSSION_CLOSE_REASONS[reason] },
      )
      : await graphqlWrite(octokit, 'mutation($discussionId: ID!) { reopenDiscussion(input: { discussionId: $discussionId }) { discussion { closed } } }', { discussionId });
    const closed = (state === 'closed' ? data?.closeDiscussion : data?.reopenDiscussion)?.discussion?.closed;
    if (closed !== (state === 'closed')) throw invalidProviderPayload('GitHub returned an unexpected state');
    return { state };
  };
  const setDiscussionAnswer = async (octokit, commentId, answer) => {
    const field = answer ? 'markDiscussionCommentAsAnswer' : 'unmarkDiscussionCommentAsAnswer';
    const data = await graphqlWrite(octokit, `mutation($id: ID!) { ${field}(input: { id: $id }) { discussion { id } } }`, { id: commentId });
    if (!isProviderString(data?.[field]?.discussion?.id)) throw invalidProviderPayload('GitHub returned an invalid answer');
    return {};
  };
  /**
   * The discussion's labels as one whole set: GitHub adds and removes them by
   * id, so the names are looked up in the repository first, and a name it
   * does not have is refused before anything changes. Asking again for the
   * same set is safe, so a failure between the two writes is fixed by trying again.
   */
  const setDiscussionLabels = async (octokit, project, discussion, labels) => {
    let ids = [];
    if (labels.length > 0) {
      const variables = { owner: project.owner, name: project.name };
      const selections = labels.map((label, index) => {
        variables[`l${index}`] = label;
        return `l${index}: label(name: $l${index}) { id name }`;
      });
      const declarations = labels.map((_label, index) => `$l${index}: String!`).join(', ');
      const data = await graphqlWrite(octokit, `query($owner: String!, $name: String!, ${declarations}) { repository(owner: $owner, name: $name) { ${selections.join(' ')} } }`, variables);
      ids = labels.map((label, index) => {
        const found = data?.repository?.[`l${index}`];
        if (!isProviderString(found?.id)) throw mutationError(`Label ${label} does not exist in this repository`, 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
        return found.id;
      });
    }
    const current = discussion.labels.map((label) => label.id);
    const add = ids.filter((id) => !current.includes(id));
    const remove = current.filter((id) => !ids.includes(id));
    if (add.length) {
      await graphqlWrite(octokit, 'mutation($id: ID!, $labelIds: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labelIds }) { clientMutationId } }', { id: discussion.id, labelIds: add });
    }
    if (remove.length) {
      try {
        await graphqlWrite(octokit, 'mutation($id: ID!, $labelIds: [ID!]!) { removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labelIds }) { clientMutationId } }', { id: discussion.id, labelIds: remove });
      } catch (error) {
        // Labels were already added: the set moved, so this is no definite
        // refusal. Without a status it stays outcome-unknown and reconciles by name.
        if (!add.length) throw error;
        throw new Error('GitHub changed only part of the labels', { cause: error });
      }
    }
    return {};
  };
  const setLabels = async (octokit, project, number, labels) => {
    const response = await rejected(() => octokit.rest.issues.setLabels({ owner: project.owner, repo: project.name, issue_number: number, labels }));
    requireProviderArray(response?.data, 'GitHub returned an invalid label list');
    return {};
  };
  const requestedReviewers = async (octokit, project, number) => {
    const response = await octokit.rest.pulls.listRequestedReviewers({ owner: project.owner, repo: project.name, pull_number: number });
    const users = response?.data?.users;
    if (!Array.isArray(users) || users.some((user) => !isProviderString(user?.login))) {
      throw invalidProviderPayload('GitHub returned an invalid reviewer list');
    }
    return users.map((user) => user.login);
  };
  // GitHub adds and removes review requests separately. Asking again for the
  // same set is safe, so a failure between the two is fixed by trying again.
  const setReviewers = async (octokit, project, number, reviewers) => {
    const current = await requestedReviewers(octokit, project, number);
    const add = reviewers.filter((login) => !current.includes(login));
    const remove = current.filter((login) => !reviewers.includes(login));
    const pull = { owner: project.owner, repo: project.name, pull_number: number };
    await rejected(async () => {
      if (add.length) await octokit.rest.pulls.requestReviewers({ ...pull, reviewers: add });
      if (remove.length) await octokit.rest.pulls.removeRequestedReviewers({ ...pull, reviewers: remove });
    });
    return {};
  };
  // Closing or reopening an issue or a pull request; GitHub refuses to reopen a merged one.
  const setState = async (update, state) => {
    const response = await rejected(update);
    if (response?.data?.state !== state) throw invalidProviderPayload('GitHub returned an unexpected state');
    return { state };
  };

  const reconcileCreate = async (octokit, expectedProject, sourceProject, head, base) => {
    const response = await octokit.rest.pulls.list({
      owner: expectedProject.owner, repo: expectedProject.name, state: 'all', head: `${sourceProject.owner}:${head}`, base, per_page: 100,
    });
    const candidates = requireProviderArray(response?.data, 'GitHub returned an invalid pull request list')
      .map((pr) => requireMutationPullRequest(pr, 'GitHub returned an invalid pull request', octokit))
      .filter((pr) => pr.head.ref === head && pr.base.ref === base)
      .filter((pr) => sameProject(pullTargetProject(pr), expectedProject))
      .filter((pr) => pr.head.repo && sameProject({ owner: pr.head.repo.owner.login, name: pr.head.repo.name }, sourceProject));
    if (candidates.length !== 1) return unknownOutcome();
    const found = candidates[0];
    // The create may have ended before its PR joined the stack below it (the
    // connection dropped, the server stopped): finish that here, so the
    // receipt says where the PR stands as the uninterrupted create would.
    const stacked = sameProject(sourceProject, expectedProject)
      ? await settleStack(octokit, expectedProject, found.number, base, found.base?.repo?.default_branch)
      : undefined;
    return { state: 'succeeded', result: stacked === undefined ? { number: found.number } : { number: found.number, stacked } };
  };

  const reconcileExisting = async (octokit, operation, target, input) => {
    // A comment or a review leaves nothing that tells a lost write from one
    // never sent short of guessing from its text, so the outcome stays unknown.
    if (['comment', 'review', 'issue-comment', 'thread-reply', 'discussion-comment'].includes(operation)) return unknownOutcome();
    const project = target.project;
    if (operation === 'discussion-state') {
      const discussion = await readDiscussion(octokit, project, target.number);
      const state = discussion.closed ? 'closed' : 'open';
      return state === input.state ? { state: 'succeeded', result: { state } } : definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    }
    if (operation === 'discussion-answer') {
      // Someone may have chosen another answer since: only the asked state is certain.
      const comment = await readDiscussionComment(octokit, input.commentId, project, target.number);
      return comment.isAnswer === input.answer ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'discussion-labels') {
      const names = (await readDiscussion(octokit, project, target.number)).labels.map((label) => label.name);
      return sameNames(names, input.labels) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'thread-resolve') {
      // Someone may have flipped it since: only the asked state is certain.
      const thread = await readReviewThread(octokit, input.threadId, project, target.number);
      return thread.isResolved === input.resolved ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'labels' || operation === 'issue-labels') {
      const current = await octokit.rest.issues.listLabelsOnIssue({ owner: project.owner, repo: project.name, issue_number: target.number, per_page: 100 });
      const names = requireProviderArray(current?.data, 'GitHub returned an invalid label list').map((label) => label?.name);
      // Another edit since may have changed them either way: only a match is certain.
      return names.every(isProviderString) && sameNames(names, input.labels) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'reviewers') {
      return sameNames(await requestedReviewers(octokit, project, target.number), input.reviewers) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'issue-state') {
      const current = await octokit.rest.issues.get({ owner: project.owner, repo: project.name, issue_number: target.number });
      const state = current?.data?.state;
      if (state !== 'open' && state !== 'closed') return unknownOutcome();
      return state === input.state ? { state: 'succeeded', result: { state } } : definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    }
    const current = await octokit.rest.pulls.get({ owner: project.owner, repo: project.name, pull_number: target.number });
    const pr = requireMutationPullRequest(current?.data, 'GitHub returned an invalid pull request', octokit);
    if (operation === 'merge') {
      // Still open says nothing certain: GitHub may be merging it in the
      // background or holding it in a merge queue. The live state follows.
      if (pr.merged === true || isProviderString(pr.merged_at)) return { state: 'succeeded', result: { merged: true } };
    } else if (operation === 'state') {
      // A merged pull request reads `closed` too, and can no longer be reopened.
      if (pr.state === input.state) return { state: 'succeeded', result: { state: pr.state } };
      if (pr.state === 'open' || pr.state === 'closed') return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    } else if (operation === 'ready') {
      if (pr.draft === false) return { state: 'succeeded', result: { ready: true } };
      if (pr.draft === true && pr.state === 'open') return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    }
    return unknownOutcome();
  };

  /** The bound repository and its fork network as projects; the target must be one of them. */
  const resolveNetworkProjects = async (octokit, context) => {
    const primary = (await resolveRepo(context.directory, context.primaryRemote))?.repo;
    if (!primary) throw mutationError('Unable to resolve trusted GitHub primary remote', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    const network = requireGitHubRepoNetwork(
      await resolveNetwork(octokit, context.directory, context.primaryRemote, { strictErrors: true }),
      primary,
    );
    const projects = [repoProject(primary), ...(network ?? []).map(repoProject)];
    if (!changeRequestNetworkTarget(projects, context.target.project, sameProject)) {
      throw mutationError('GitHub mutation target is outside the bound repository network', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    }
    return projects;
  };

  const baseTarget = (context, project) => ({
    repositoryId: context.repositoryId,
    bindingRevision: context.bindingRevision,
    primaryRemote: context.primaryRemote,
    project: { id: `${project.owner}/${project.name}`, owner: project.owner, name: project.name },
  });

  /** The preflight before a new key's write: provider coordinates checked against GitHub now. */
  const resolveNew = async (octokit, context, operation, input) => {
    const projects = await resolveNetworkProjects(octokit, context);
    const expectedProject = context.target.project;
    if (operation === 'create') {
      if (input.remote) {
        const selected = (await resolveRepo(context.directory, input.remote))?.repo;
        if (!selected || !sameProject(repoProject(selected), expectedProject)) {
          throw mutationError('remote does not match the mutation target', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
        }
      }
      const sourceRepo = (await resolveRepo(context.directory, input.headRemote))?.repo;
      const sourceProject = sourceRepo ? repoProject(sourceRepo) : null;
      if (!sourceProject || !projects.some((project) => sameProject(project, sourceProject))) {
        throw mutationError('GitHub mutation source is outside the bound repository network', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      }
      return {
        providerTarget: { sourceProject },
        target: { ...baseTarget(context, expectedProject), head: input.head, base: input.base },
      };
    }
    const expected = context.target;
    if (DISCUSSION_KINDS.has(operation)) {
      if (expected.head !== undefined || expected.base !== undefined || expected.headSha !== undefined) {
        throw mutationError('Discussion target is invalid');
      }
      const discussion = await readDiscussion(octokit, expectedProject, expected.number);
      // A reply answers a comment's thread, and only a comment of this discussion takes an answer or a reply.
      const commentId = operation === 'discussion-answer' ? input.commentId : operation === 'discussion-comment' ? input.replyTo : undefined;
      if (commentId) {
        const comment = await readDiscussionComment(octokit, commentId, expectedProject, expected.number);
        if (operation === 'discussion-comment' && comment.reply) {
          throw mutationError('A reply answers a comment, not another reply', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
        }
      }
      return { providerTarget: { discussion }, target: { ...baseTarget(context, expectedProject), number: expected.number } };
    }
    if (ISSUE_KINDS.has(operation)) {
      if (expected.head !== undefined || expected.base !== undefined || expected.headSha !== undefined) {
        throw mutationError('Issue target is invalid');
      }
      const issue = (await octokit.rest.issues.get({ owner: expectedProject.owner, repo: expectedProject.name, issue_number: expected.number }))?.data;
      if (!isPlainObject(issue) || issue.number !== expected.number) throw invalidProviderPayload('GitHub returned an invalid issue');
      // GitHub lists pull requests among issues; this write is for issues only.
      if (issue.pull_request) throw mutationError('GitHub issue is a pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      return { providerTarget: {}, target: { ...baseTarget(context, expectedProject), number: issue.number } };
    }
    const response = await octokit.rest.pulls.get({ owner: expectedProject.owner, repo: expectedProject.name, pull_number: expected.number });
    const pr = requireMutationPullRequest(response?.data, 'GitHub returned an invalid pull request', octokit);
    if (!sameProject(pullTargetProject(pr), expectedProject) || !targetMatches(expected, pr)) {
      throw mutationError('GitHub pull request no longer matches the mutation target', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', 409);
    }
    const target = { ...baseTarget(context, expectedProject), number: pr.number, head: pr.head.ref, base: pr.base.ref, headSha: pr.head.sha };
    if (operation === 'thread-reply' || operation === 'thread-resolve') {
      await readReviewThread(octokit, input.threadId, expectedProject, target.number);
    }
    if (operation === 'ready') {
      const alreadyReady = pr.draft === false;
      const nodeId = optionalText(pr.node_id, 'pull request node id', true);
      if (!alreadyReady && !nodeId) throw invalidProviderPayload('GitHub returned an invalid pull request node id');
      return { providerTarget: { alreadyReady, nodeId: nodeId ?? null }, target };
    }
    return { providerTarget: {}, target };
  };

  const performOperation = async (octokit, operation, input, { providerTarget, target }) => {
    const project = target.project;
    switch (operation) {
      case 'create': {
        const { sourceProject } = providerTarget;
        const createInput = {
          owner: project.owner,
          repo: project.name,
          title: input.title,
          head: sameProject(sourceProject, project) ? input.head : `${sourceProject.owner}:${input.head}`,
          base: input.base,
        };
        if (input.body !== undefined) createInput.body = input.body;
        if (input.draft !== undefined) createInput.draft = input.draft;
        const response = await octokit.rest.pulls.create(createInput);
        const created = requireMutationPullRequest(response?.data, 'GitHub returned an invalid created pull request', octokit);
        const createdSource = created.head.repo ? { owner: created.head.repo.owner.login, name: created.head.repo.name } : null;
        if (!targetMatches({ number: created.number, head: input.head, base: input.base }, created)
          || !sameProject(pullTargetProject(created), project)
          || !sameProject(createdSource, sourceProject)) {
          throw invalidProviderPayload('GitHub returned a created pull request with an unexpected target');
        }
        // A PR on another open PR's branch is that one's next layer. Recorded
        // durably so a replay or restart still names the new PR and its stack.
        const stacked = sameProject(sourceProject, project)
          ? await stackOnParent(octokit, project, created.number, input.base, created.base?.repo?.default_branch)
          : undefined;
        return stacked === undefined ? { number: created.number } : { number: created.number, stacked };
      }
      case 'update': {
        const updateInput = { owner: project.owner, repo: project.name, pull_number: target.number, title: input.title };
        if (input.body !== undefined) updateInput.body = input.body;
        const updated = requireMutationPullRequest((await octokit.rest.pulls.update(updateInput))?.data, 'GitHub returned an invalid updated pull request', octokit);
        if (!sameProject(pullTargetProject(updated), project) || !targetMatches(target, updated)) {
          throw invalidProviderPayload('GitHub returned an updated pull request with an unexpected target');
        }
        return {};
      }
      case 'merge':
        return mergePullRequest(octokit, project, target, input.method);
      case 'labels':
      case 'issue-labels':
        return setLabels(octokit, project, target.number, input.labels);
      case 'reviewers':
        return setReviewers(octokit, project, target.number, input.reviewers);
      case 'state':
        return setState(() => octokit.rest.pulls.update({ owner: project.owner, repo: project.name, pull_number: target.number, state: input.state }), input.state);
      case 'issue-state':
        return setState(() => octokit.rest.issues.update({ owner: project.owner, repo: project.name, issue_number: target.number, state: input.state }), input.state);
      case 'comment':
      case 'issue-comment':
        return postComment(octokit, project, target.number, input.body);
      case 'thread-reply':
        return replyToReviewThread(octokit, input.threadId, input.body);
      case 'thread-resolve':
        return setReviewThreadResolved(octokit, input.threadId, input.resolved);
      case 'discussion-comment':
        return commentOnDiscussion(octokit, providerTarget.discussion.id, input.body, input.replyTo);
      case 'discussion-state':
        return setDiscussionState(octokit, providerTarget.discussion.id, input.state, input.reason);
      case 'discussion-answer':
        return setDiscussionAnswer(octokit, input.commentId, input.answer);
      case 'discussion-labels':
        return setDiscussionLabels(octokit, project, providerTarget.discussion, input.labels);
      case 'review': {
        const reviewInput = {
          owner: project.owner,
          repo: project.name,
          pull_number: target.number,
          // The verdict is for the commit the user read.
          commit_id: target.headSha,
          event: input.verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
        };
        if (input.body !== undefined) reviewInput.body = input.body;
        const response = await rejected(() => octokit.rest.pulls.createReview(reviewInput));
        if (response?.data?.state !== (input.verdict === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED')) {
          throw invalidProviderPayload('GitHub returned an invalid review');
        }
        // GitHub posts the verdict and its text as one review.
        return { commented: input.body !== undefined };
      }
      case 'ready': {
        if (!providerTarget.alreadyReady) {
          const ready = await octokit.graphql(
            `mutation($pullRequestId: ID!) {\n  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {\n    pullRequest {\n      id\n      isDraft\n    }\n  }\n}`,
            { pullRequestId: providerTarget.nodeId },
          );
          const result = ready?.markPullRequestReadyForReview?.pullRequest;
          if (!isPlainObject(result) || result.id !== providerTarget.nodeId || result.isDraft !== false) {
            throw invalidProviderPayload('GitHub returned an invalid ready-for-review result');
          }
        }
        return { ready: true };
      }
      default:
        throw mutationError('Mutation kind is invalid');
    }
  };

  return Object.freeze({
    routes: Object.freeze(Object.keys(ROUTE_OPERATIONS)),
    prepare: ({ route, input, context, actor, credential }) => {
      const operation = ROUTE_OPERATIONS[route];
      if (!operation) throw mutationError('Source control mutation is unsupported');
      const normalized = normalizeOperation(operation, input ?? {}, context, actor, credential, descriptor.limits);
      return { kind: recordKind(operation), input: normalized.input, digest: normalized.digest };
    },
    /**
     * The provider coordinates and the durable target. A retried key keeps
     * its stored target; only a create needs its source project again, to
     * find what it may have made.
     */
    resolveTarget: async ({ session, context, kind, input, replayOf }) => {
      const operation = operationOf(kind);
      const octokit = octokitOf(session);
      if (replayOf) {
        if (operation !== 'create') return { providerTarget: {}, target: replayOf.target };
        const sourceRepo = (await resolveRepo(context.directory, input.headRemote))?.repo;
        return { providerTarget: { sourceProject: sourceRepo ? repoProject(sourceRepo) : null }, target: replayOf.target };
      }
      return rejected(() => resolveNew(octokit, context, operation, input));
    },
    /**
     * What a succeeded mutation leaves stale: the target's cached context and
     * its repository's pull lists. The shell calls it after the record is
     * durable, so a failure here never turns a landed write into an unknown one.
     */
    afterSuccess: async ({ session, target }) => {
      onSucceeded({ session, target });
      await invalidatePulls(target.project.owner, target.project.name, octokitOf(session));
    },
    perform: async ({ session, kind, input, resolved }) => {
      const operation = operationOf(kind);
      return performOperation(octokitOf(session), operation, input, resolved);
    },
    reconcile: async ({ session, kind, input, resolved }) => {
      const operation = operationOf(kind);
      const octokit = octokitOf(session);
      const { target, providerTarget } = resolved;
      return operation === 'create'
        ? providerTarget.sourceProject
          ? await reconcileCreate(octokit, target.project, providerTarget.sourceProject, target.head, target.base)
          : unknownOutcome()
        : await reconcileExisting(octokit, operation, target, input);
    },
    /** A provider 4xx is a definite failure, recorded with its status and a stable code; anything else may have happened. */
    classifyError: (error) => {
      const status = error?.response?.status ?? error?.status;
      if (Number.isSafeInteger(status) && status >= 400 && status <= 499) {
        if (!Number.isSafeInteger(error.status)) error.status = status;
        if (!isProviderString(error.code)) error.code = 'GITHUB_MUTATION_REJECTED';
        return 'failed';
      }
      return 'outcome-unknown';
    },
    /**
     * How a failed mutation answers: GitHub's reason for a refusal, the
     * module's own message for its own errors, and otherwise a generic answer
     * whose cause goes to the log by status and code, never by message, which
     * may echo private input.
     */
    presentError: (failure) => {
      const error = failure?.response ? providerRejection(failure) : failure;
      const status = Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const code = isProviderString(error?.code) && error.code ? error.code : 'GITHUB_MUTATION_FAILED';
      const ownMessage = code.startsWith('SOURCE_CONTROL_') || code.startsWith('INVALID_SOURCE_CONTROL_');
      if (!ownMessage && status !== 401) console.warn(`GitHub mutation failed: ${status} ${code} ${error?.name ?? 'unknown'}`);
      const message = ownMessage ? error.message : status === 401 ? 'GitHub account is unavailable' : 'GitHub mutation failed';
      const body = { error: message, code };
      if (error?.current !== undefined) body.current = error.current;
      return { status, body };
    },
  });
}
