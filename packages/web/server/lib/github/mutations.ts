import { digestMutationInput } from '../source-control/mutation-executor.js';
import { changeRequestNetworkTarget } from '../source-control/repository-network.js';
import { reviewCommentPosition } from '../source-control/review-position.js';
import { cancelWaitingMerge, enableMergeWhenReady, readWaitingMerge } from './merge-when-ready.js';
import {
  invalidProviderPayload,
  isPlainObject,
  isProviderString,
  matchesGitHubRepositoryUrl,
  requireGitHubPullRequest,
  requireGitHubRepoNetwork,
  requireProviderArray,
} from './mappers.js';
import { readPendingReview } from './review-draft.js';
import { normalizeAssignees, normalizeStateOperation, performAssignees, performIssueState, reconcileAssignees, reconcileIssueState } from './mutations-items.js';
import { CONVERSATION_COMMENT_KINDS, DISCUSSION_CLOSE_REASONS, DISCUSSION_KINDS, ISSUE_KINDS, operationOf, recordKind } from './record-kinds.js';
import { isSourceControlInteger } from '../source-control/input-guards.js';
import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { AccountIdentity, ProviderDescriptor, ProviderMutationContext, ProviderSession } from '../source-control/provider-contract.js';
import type { MutationCompletion, MutationRecord, MutationResult } from '../source-control/mutation-storage.js';
import type { GitHubResourceOptions } from './resources.js';
import type { GitHubEnvelope, Octokit, RestEndpointMethodTypes } from './contracts.js';
import type { PullInput } from './mappers.js';

type MutationTarget = SourceControlMutationTarget;
type Project = Pick<MutationTarget['project'], 'owner' | 'name'>;
type MergeMethod = 'merge' | 'squash' | 'rebase';
type ItemState = 'open' | 'closed';
type Credential = { accountId: string; credentialRevision: number };
type Rest = RestEndpointMethodTypes;
interface MutationPull {
  number: number;
  state: ItemState;
  merged?: unknown;
  merged_at?: unknown;
  draft?: unknown;
  node_id?: unknown;
  head: { ref: string; sha: string; repo?: { owner: { login: string }; name: string } | null };
  base: { ref: string; repo: { owner: { login: string }; name: string; default_branch?: unknown } };
}
type ReviewPosition = ReturnType<typeof reviewCommentPosition>;
type Discussion = { id: string; closed: boolean; labels: { id: string; name: string }[]; title: string | undefined; body: string | undefined };
interface GitHubMutationOptions {
  descriptor: ProviderDescriptor;
  octokitOf(session: ProviderSession): Octokit & { openChamberHost?: string };
  resolveRepo: GitHubResourceOptions['resolveRepo'];
  resolveNetwork: GitHubResourceOptions['resolveNetwork'];
  invalidatePulls(owner: string, repo: string, octokit: Octokit): Promise<void>;
  onSucceeded(input: { session: ProviderSession; target: MutationTarget }): void;
}
export interface GitHubMutationInput {
  title?: string | undefined; body?: string | undefined; draft?: boolean | undefined; remote?: string | undefined;
  headRemote?: string | undefined; head?: string | undefined; base?: string | undefined; method?: MergeMethod; cancel?: boolean;
  labels?: string[]; reviewers?: string[]; assignees?: string[]; replyTo?: string | undefined; state?: ItemState; reason?: SourceControlJson | undefined;
  commentId?: number | string; answer?: boolean; threadId?: string; resolved?: boolean; verdict?: SourceControlJson | undefined;
  path?: string; side?: ReviewPosition['side']; line?: number; startLine?: number;
}
export interface GitHubMutationTarget {
  sourceProject?: Project | null;
  discussion?: Discussion;
  pendingReviewId?: unknown;
  pullRequestId?: unknown;
  already?: boolean;
  nodeId?: string | null;
}
export interface MutationStep {
  session: ProviderSession;
  route: string; kind: string;
  input: GitHubMutationInput;
  resolved: { providerTarget: GitHubMutationTarget; target: MutationTarget };
}
export interface MutationPreparation {
  route: string; input: SourceControlJsonObject | null | undefined; context: ProviderMutationContext; actor: AccountIdentity; credential: Credential;
}
export interface MutationResolution {
  session: ProviderSession; context: ProviderMutationContext; kind: string; input: GitHubMutationInput; replayOf?: MutationRecord;
}
export interface NormalizedGitHubMutation { input: GitHubMutationInput; digest(target: MutationTarget): string }
export interface GitHubMutationErrorBody { error: unknown; code: string; current?: unknown }
interface LabelVariables { owner: string; name: string; [label: `l${number}`]: string }
interface MutationFailure {
  response?: unknown; status?: unknown; code?: unknown; message?: unknown; errors?: unknown; data?: unknown;
  current?: unknown; name?: unknown;
}
const hasFailureFields = (value: unknown): value is MutationFailure => value != null;
const failureFields = (cause: unknown) => hasFailureFields(cause) ? cause : undefined;
const statusOf = (cause: unknown) => {
  const error = failureFields(cause);
  return failureFields(error?.response)?.status ?? error?.status;
};
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const hasGraphQLField = <Key extends string>(value: unknown, _key: Key): value is { [Name in Key]?: unknown } =>
  value != null;
const fieldAt = <Key extends string>(value: GitHubEnvelope['data'], key: Key) =>
  hasGraphQLField(value, key) ? value[key] : undefined;
const gqlPath = (value: GitHubEnvelope['data'], ...keys: string[]) => keys.reduce<GitHubEnvelope['data']>(fieldAt, value);
const requireField = <Value>(value: Value, name: string): NonNullable<Value> => {
  if (value == null) throw new TypeError(`GitHub mutation field ${name} is missing`);
  return value;
};
const isMergeMethod = (value: unknown): value is MergeMethod => value === 'merge' || value === 'squash' || value === 'rebase';
const isJsonBoolean = (value: SourceControlJson | undefined): value is boolean =>
  Object.prototype.toString.call(value) === '[object Boolean]';
const restId = (value: GitHubMutationInput['commentId']) => {
  if (!isSourceControlInteger(value)) throw new TypeError('GitHub REST comment ID is missing');
  return value;
};
const graphqlId = (value: GitHubMutationInput['commentId']) => {
  if (!isProviderString(value)) throw new TypeError('GitHub GraphQL comment ID is missing');
  return value;
};
const isNameList = (value: unknown): value is string[] => isArray(value)
  && !value.some((entry) => !isProviderString(entry) || !entry.trim() || entry.length > 256);
const isDiscussionLabelList = (values: unknown): values is Discussion['labels'] => isArray(values)
  && !values.some((label) => !isProviderString(fieldAt(label, 'id')) || !isProviderString(fieldAt(label, 'name')));

const ROUTE_OPERATIONS = Object.freeze({
  '/pr/create': 'create',
  '/pr/update': 'update',
  '/pr/merge': 'merge',
  '/pr/ready': 'ready',
  '/pr/draft': 'draft',
  '/pr/comment': 'comment',
  '/pr/review': 'review',
  '/pr/review/comment': 'review-comment',
  '/pr/review/comment/update': 'review-comment-update',
  '/pr/review/comment/delete': 'review-comment-delete',
  '/pr/review/discard': 'review-discard',
  '/pr/thread/reply': 'thread-reply',
  '/pr/thread/resolve': 'thread-resolve',
  '/pr/comment/update': 'change-request-comment-update',
  '/pr/comment/delete': 'change-request-comment-delete',
  '/issues/comment': 'issue-comment',
  '/issues/update': 'issue-update',
  '/issues/comment/update': 'issue-comment-update',
  '/issues/comment/delete': 'issue-comment-delete',
  '/pr/state': 'state',
  '/issues/state': 'issue-state',
  '/pr/labels': 'labels',
  '/issues/labels': 'issue-labels',
  '/pr/reviewers': 'reviewers',
  '/issues/assignees': 'issue-assignees',
  '/discussions/comment': 'discussion-comment',
  '/discussions/comment/update': 'discussion-comment-update',
  '/discussions/comment/delete': 'discussion-comment-delete',
  '/discussions/state': 'discussion-state',
  '/discussions/answer': 'discussion-answer',
  '/discussions/labels': 'discussion-labels',
  '/discussions/update': 'discussion-update',
});

const REVIEW_DRAFT_OPERATIONS = new Set(['review-comment', 'review-comment-update', 'review-comment-delete', 'review-discard']);
const REVIEW_EVENTS = Object.freeze({
  approve: { event: 'APPROVE', state: 'APPROVED' },
  'request-changes': { event: 'REQUEST_CHANGES', state: 'CHANGES_REQUESTED' },
  comment: { event: 'COMMENT', state: 'COMMENTED' },
});

const mutationError = (message: string, code = 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status = 400) => Object.assign(new Error(message), { code, status });
const definiteFailure = (code: string): MutationCompletion => ({ state: 'failed', result: { failureStatus: 409, failureCode: code } });
const unknownOutcome = (): MutationCompletion => ({ state: 'outcome-unknown' });

const sameProject = (left: { owner?: string | undefined; name?: string | undefined } | null | undefined, right: Project | null | undefined) => left?.owner === right?.owner && left?.name === right?.name;
const sameNames = (left: string[], right: string[]) => left.length === right.length && [...left].sort().every((entry, index) => entry === right[index]);
const repoProject = (repo: { owner: string; repo: string }) => ({ owner: repo.owner, name: repo.repo });
const pullTargetProject = (pr: MutationPull) => ({ owner: pr.base.repo.owner.login, name: pr.base.repo.name });
const targetMatches = (expected: Pick<MutationTarget, 'number' | 'head' | 'base' | 'headSha'>, pr: MutationPull) => pr.number === expected.number
  && (expected.head === undefined || pr.head.ref === expected.head)
  && (expected.base === undefined || pr.base.ref === expected.base)
  && (expected.headSha === undefined || pr.head.sha === expected.headSha);

const providerRejection = (cause: unknown) => {
  const status = statusOf(cause);
  if (status !== 403 && status !== 404 && status !== 405 && status !== 409 && status !== 422) return cause;
  const data = failureFields(failureFields(failureFields(cause)?.response)?.data);
  const first = isArray(data?.errors) ? data.errors[0] : undefined;
  const detail = [first, failureFields(first)?.message, data?.message].find((value): value is string => isProviderString(value) && Boolean(value.trim()));
  return mutationError(detail ?? 'GitHub refused the change', 'SOURCE_CONTROL_MUTATION_REJECTED', status);
};

// external: https://docs.github.com/en/graphql/overview/resource-limitations GraphQL can report a refused write in errors with HTTP 200.
const graphqlRejection = (cause: unknown) => {
  const errors = failureFields(cause)?.errors;
  const matching = isArray(errors) ? errors.find((entry) => isProviderString(failureFields(entry)?.message)) : undefined;
  const message = failureFields(matching)?.message;
  return isProviderString(message) && message ? mutationError(message, 'SOURCE_CONTROL_MUTATION_REJECTED', 422) : providerRejection(cause);
};

const rejected = async <Result>(operation: () => Promise<Result>) => {
  try {
    return await operation();
  } catch (error) {
    throw failureFields(error)?.response ? providerRejection(error) : error;
  }
};

function commentText(value: SourceControlJson | undefined, required: true, maxLength: number): string;
function commentText(value: SourceControlJson | undefined, required: boolean, maxLength: number): string | undefined;
function commentText(value: SourceControlJson | undefined, required: boolean, maxLength: number) {
  if (value === undefined && !required) return undefined;
  if (!isProviderString(value) || !value.trim()) throw mutationError('body is required');
  if (value.length > maxLength) throw mutationError('body is too long');
  return value;
}
const nodeId = (value: SourceControlJson | undefined, name: string) => {
  if (!isProviderString(value) || !/^[A-Za-z0-9_=-]{1,200}$/.test(value)) throw mutationError(`${name} is invalid`);
  return value;
};
const restCommentId = (value: SourceControlJson | undefined) => {
  const id = isProviderString(value) || Number.isSafeInteger(value) ? String(value).trim() : '';
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw mutationError('commentId is invalid');
  return Number(id);
};
const reviewThreadId = (value: SourceControlJson | undefined) => nodeId(value, 'threadId');
const nameList = (value: SourceControlJson | undefined, name: string, limit: number): string[] => {
  if (!isArray(value) || value.length > limit || !isNameList(value)) {
    throw mutationError(`${name} are invalid`);
  }
  return [...new Set(value)].sort();
};
const requiredText = (value: SourceControlJson | undefined, name: string) => {
  if (!isProviderString(value) || !value.trim()) throw mutationError(`${name} is required`);
  return value.trim();
};
const optionalText = (value: GitHubEnvelope['data'], name: string, trim = false) => {
  if (value === undefined) return undefined;
  if (!isProviderString(value)) throw mutationError(`${name} is invalid`);
  const normalized = trim ? value.trim() : value;
  if (trim && !normalized) throw mutationError(`${name} is invalid`);
  return normalized;
};

function normalizeOperation(operation: string, body: SourceControlJsonObject, context: ProviderMutationContext, actor: AccountIdentity, credential: Credential, limits: ProviderDescriptor['limits']): NormalizedGitHubMutation {
  const digestOf = <Fields extends { target: MutationTarget }>(fields: Fields) => digestMutationInput({ kind: operation, actor, credential, ...fields });
  if (operation === 'create') {
    const title = requiredText(body.title, 'title');
    const text = optionalText(body.body, 'body');
    if (body.draft !== undefined && !isJsonBoolean(body.draft)) {
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
        const fields: { target: MutationTarget } & Pick<GitHubMutationInput, 'title' | 'headRemote' | 'body' | 'draft' | 'remote'> = { target, title, headRemote };
        if (text !== undefined) fields.body = text;
        if (draft !== undefined) fields.draft = draft;
        if (remote) fields.remote = remote;
        return digestOf(fields);
      },
    };
  }

  if (!isSourceControlInteger(context.target.number) || context.target.number < 1) throw mutationError('target number is required');
  if (operation === 'update' || operation === 'issue-update' || operation === 'discussion-update') {
    const title = requiredText(body.title, 'title');
    const text = optionalText(body.body, 'body');
    return {
      input: { title, body: text },
      digest: (target) => digestOf(text === undefined ? { target, title } : { target, title, body: text }),
    };
  }
  if (operation === 'merge') {
    const method = requiredText(body.method, 'method');
    if (!isMergeMethod(method)) throw mutationError('merge method is invalid');
    if (body.cancel !== undefined && body.cancel !== true && body.cancel !== false) throw mutationError('cancel is invalid');
    return body.cancel === true
      ? { input: { method, cancel: true }, digest: (target) => digestOf({ target, method, cancel: true }) }
      : { input: { method }, digest: (target) => digestOf({ target, method }) };
  }
  if (operation === 'ready' || operation === 'draft') return { input: {}, digest: (target) => digestOf({ target }) };
  if (operation === 'labels' || operation === 'issue-labels' || operation === 'discussion-labels') {
    const labels = nameList(body.labels, 'labels', limits.labelsMax);
    return { input: { labels }, digest: (target) => digestOf({ target, labels }) };
  }
  if (operation === 'discussion-comment') {
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
    if (body.state !== 'closed' || !Object.hasOwn(DISCUSSION_CLOSE_REASONS, String(body.reason))) throw mutationError('state is invalid');
    const { reason } = body;
    return { input: { state: 'closed', reason }, digest: (target) => digestOf({ target, state: 'closed', reason }) };
  }
  if (operation === 'discussion-answer') {
    const commentId = nodeId(body.commentId, 'commentId');
    if (body.answer !== true && body.answer !== false) throw mutationError('answer is invalid');
    const { answer } = body;
    return { input: { commentId, answer }, digest: (target) => digestOf({ target, commentId, answer }) };
  }
  if (operation === 'change-request-comment-update' || operation === 'issue-comment-update') {
    const commentId = restCommentId(body.commentId);
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'change-request-comment-delete' || operation === 'issue-comment-delete') {
    const commentId = restCommentId(body.commentId);
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'discussion-comment-update') {
    const commentId = nodeId(body.commentId, 'commentId');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'discussion-comment-delete') {
    const commentId = nodeId(body.commentId, 'commentId');
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'reviewers') {
    const reviewers = nameList(body.reviewers, 'reviewers', limits.reviewersMax);
    return { input: { reviewers }, digest: (target) => digestOf({ target, reviewers }) };
  }
  if (operation === 'issue-assignees') return normalizeAssignees(body, limits, digestOf, nameList);
  if (operation === 'state' || operation === 'issue-state') return normalizeStateOperation(operation, body, digestOf, mutationError);
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
    if (!Object.hasOwn(REVIEW_EVENTS, String(verdict))) throw mutationError('review verdict is invalid');
    requiredText(context.target.headSha, 'target headSha');
    const text = commentText(body.body, verdict === 'request-changes', limits.commentMaxLength);
    return {
      input: { verdict, body: text },
      digest: (target) => digestOf(text === undefined ? { target, verdict } : { target, verdict, body: text }),
    };
  }
  if (operation === 'review-comment') {
    requiredText(context.target.headSha, 'target headSha');
    const position = reviewCommentPosition(body, (message) => { throw mutationError(message); });
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { ...position, body: text }, digest: (target) => digestOf({ target, ...position, body: text }) };
  }
  if (operation === 'review-comment-update') {
    const commentId = nodeId(body.commentId, 'commentId');
    const text = commentText(body.body, true, limits.commentMaxLength);
    return { input: { commentId, body: text }, digest: (target) => digestOf({ target, commentId, body: text }) };
  }
  if (operation === 'review-comment-delete') {
    const commentId = nodeId(body.commentId, 'commentId');
    return { input: { commentId }, digest: (target) => digestOf({ target, commentId }) };
  }
  if (operation === 'review-discard') return { input: {}, digest: (target) => digestOf({ target }) };
  throw mutationError('Mutation kind is invalid');
}

export function createGitHubMutations({ descriptor, octokitOf, resolveRepo, resolveNetwork, invalidatePulls, onSucceeded }: GitHubMutationOptions) {
  const requireMutationPullRequest = (value: GitHubEnvelope['data'], message: string, octokit: ReturnType<GitHubMutationOptions['octokitOf']>): MutationPull => {
    const hasPullFields = (raw: unknown): raw is PullInput => isPlainObject(raw);
    const valid = (raw: unknown): raw is MutationPull => {
      if (!hasPullFields(raw)) return false;
      const pr = requireGitHubPullRequest(raw, message);
      const repo = gqlPath(pr.base, 'repo');
      const owner = fieldAt(repo, 'owner');
      const login = fieldAt(owner, 'login');
      const name = fieldAt(repo, 'name');
      const headSha = fieldAt(pr.head, 'sha');
      return isProviderString(headSha) && Boolean(headSha.trim())
        && Object.prototype.toString.call(fieldAt(raw, 'draft')) === '[object Boolean]'
        && Object.prototype.toString.call(fieldAt(raw, 'merged')) === '[object Boolean]'
        && isPlainObject(repo) && isPlainObject(owner)
        && isProviderString(login) && Boolean(login.trim())
        && isProviderString(name) && Boolean(name.trim())
        && matchesGitHubRepositoryUrl(fieldAt(repo, 'html_url'), login, name, octokit?.openChamberHost || '');
    };
    if (!valid(value)) throw invalidProviderPayload(message);
    return value;
  };

  const stackOnParent = async (octokit: Octokit, project: Project, number: number, base: string | undefined, defaultBranch: MutationPull['base']['repo']['default_branch']) => {
    if (!defaultBranch || base === defaultBranch) return undefined;
    const route = { owner: project.owner, repo: project.name };
    let parent;
    try {
      const listed = await octokit.rest.pulls.list({ ...route, state: 'open', head: `${project.owner}:${base}`, per_page: 5 });
      const pulls: GitHubEnvelope['data'] = listed?.data;
      parent = (isArray(pulls) ? pulls : []).find((pr) => {
        const repo = gqlPath(pr, 'head', 'repo');
        return isPlainObject(pr) && fieldAt(pr, 'number') !== number && gqlPath(pr, 'head', 'ref') === base
          && fieldAt(repo, 'name') === project.name && gqlPath(repo, 'owner', 'login') === project.owner;
      });
    } catch {
      return undefined;
    }
    if (!parent) return undefined;
    try {
      const parentNumber = fieldAt(parent, 'number');
      const listedStacks = await octokit.request('GET /repos/{owner}/{repo}/stacks', { ...route, pull_request: parentNumber });
      const stacks: GitHubEnvelope['data'] = listedStacks?.data;
      const stack = isArray(stacks) ? stacks[0] : null;
      if (isPlainObject(stack) && isSourceControlInteger(fieldAt(stack, 'number'))) {
        await octokit.request('POST /repos/{owner}/{repo}/stacks/{stack_number}/add', { ...route, stack_number: fieldAt(stack, 'number'), pull_requests: [number] });
      } else {
        await octokit.request('POST /repos/{owner}/{repo}/stacks', { ...route, pull_requests: [parentNumber, number] });
      }
      return true;
    } catch {
      return false;
    }
  };

  const settleStack = async (octokit: Octokit, project: Project, number: number, base: string | undefined, defaultBranch: MutationPull['base']['repo']['default_branch']) => {
    let listed;
    try {
      listed = await octokit.request('GET /repos/{owner}/{repo}/stacks', { owner: project.owner, repo: project.name, pull_request: number });
    } catch {
      return undefined;
    }
    const stacks: GitHubEnvelope['data'] = listed?.data;
    if (!isArray(stacks)) return undefined;
    if (stacks.some((stack) => isPlainObject(stack) && Number.isSafeInteger(fieldAt(stack, 'number')))) return true;
    return stackOnParent(octokit, project, number, base, defaultBranch);
  };

  const MERGE_ASYNC_POLL_MS = 1000;
  const MERGE_ASYNC_WAIT_MS = 20_000;
  const isMergeAsyncStatus = (value: unknown): value is 'pending' | 'merged' | 'enqueued' | 'failed' =>
    value === 'pending' || value === 'merged' || value === 'enqueued' || value === 'failed';
  const isMergeAsyncAnswer = (data: unknown): data is { status: 'pending' | 'merged' | 'enqueued' | 'failed'; details?: unknown } =>
    isPlainObject(data) && isMergeAsyncStatus(fieldAt(data, 'status'));
  const mergeAsyncAnswer = (data: GitHubEnvelope['data']) => {
    if (!isMergeAsyncAnswer(data)) throw invalidProviderPayload('GitHub returned an invalid merge result');
    const details = isPlainObject(data.details) ? data.details : {};
    const uuid = fieldAt(details, 'uuid');
    const message = fieldAt(details, 'message');
    return {
      status: data.status,
      uuid: isProviderString(uuid) ? uuid : null,
      message: isProviderString(message) ? message : null,
    };
  };
  type MergeTarget = Parameters<typeof readWaitingMerge>[2];
  const mergeClassic = async (octokit: Octokit, project: Project, target: MergeTarget, method: MergeMethod) => {
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
  const mergePullRequest = async (octokit: Octokit, project: Project, target: MergeTarget, method: MergeMethod): Promise<MutationResult> => {
    const whenReady = async () => {
      try { return await enableMergeWhenReady(octokit, project, target, method); }
      catch (error) { throw graphqlRejection(error); }
    };
    const route = { owner: project.owner, repo: project.name, pull_number: target.number };
    let answer;
    try {
      const response = await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async', {
        ...route, merge_method: method, sha: target.headSha, bypass_rules: true,
      });
      answer = mergeAsyncAnswer(response?.data);
    } catch (error) {
      const status = statusOf(error);
      if (status === 404) {
        try { return await mergeClassic(octokit, project, target, method); }
        catch (classicError) {
          const classicStatus = statusOf(classicError);
          if (classicStatus === 403 || classicStatus === 405 || classicStatus === 422) {
            const waiting = await whenReady();
            if (waiting) return waiting;
          }
          throw providerRejection(classicError);
        }
      }
      if (status === 400 || status === 403 || status === 405 || status === 422) {
        const waiting = await whenReady();
        if (waiting) return waiting;
      }
      const data = failureFields(failureFields(error)?.response)?.data;
      if (status !== 409 || !isMergeAsyncAnswer(data)) throw providerRejection(error);
      answer = mergeAsyncAnswer(data);
    }
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
      const waiting = await whenReady();
      if (waiting) return waiting;
      throw mutationError(answer.message ?? 'GitHub could not merge the pull request', 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
    }
    if (answer.status === 'merged') return { merged: true };
    return { merged: false, outcome: answer.status === 'enqueued' ? 'queued' : 'merging' };
  };

  const postComment = async (octokit: Octokit, project: Project, number: number, body: string) => {
    const response = await rejected(() => octokit.rest.issues.createComment({ owner: project.owner, repo: project.name, issue_number: number, body }));
    const data = fieldAt(response, 'data');
    if (!isPlainObject(data) || !Number.isSafeInteger(fieldAt(data, 'id'))) throw invalidProviderPayload('GitHub returned an invalid comment');
    return {};
  };

  const commentUrlTarget = (value: GitHubEnvelope['data']) => {
    if (!isProviderString(value)) return null;
    let pathname;
    try { pathname = new URL(value.trim()).pathname; } catch { return null; }
    const match = /\/(?:repos\/([^/]+)\/([^/]+)\/issues|([^/]+)\/([^/]+)\/(?:issues|pull))\/([1-9]\d*)\/?$/.exec(pathname);
    if (!match) return null;
    const [, apiOwner, apiName, webOwner, webName, number] = match;
    try {
      return { owner: decodeURIComponent(apiOwner ?? requireField(webOwner, 'owner')), name: decodeURIComponent(apiName ?? requireField(webName, 'name')), number: Number(number) };
    } catch {
      return null;
    }
  };
  const requireConversationComment = async (octokit: Octokit, commentId: number, project: Project, number: number) => {
    const comment = fieldAt(await rejected(() => octokit.rest.issues.getComment({ owner: project.owner, repo: project.name, comment_id: commentId })), 'data');
    if (!isPlainObject(comment) || !isProviderString(fieldAt(comment, 'body'))) throw invalidProviderPayload('GitHub returned an invalid comment');
    const onTarget = [fieldAt(comment, 'issue_url'), fieldAt(comment, 'html_url')].map(commentUrlTarget)
      .some((target) => target?.number === number
        && target.owner.toLowerCase() === project.owner.toLowerCase()
        && target.name.toLowerCase() === project.name.toLowerCase());
    if (!onTarget) throw mutationError('Comment is not on this issue or pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
  };
  const readConversationCommentBody = async (octokit: Octokit, project: Project, commentId: number) => {
    try {
      const comment = (await octokit.rest.issues.getComment({ owner: project.owner, repo: project.name, comment_id: commentId }))?.data;
      return isPlainObject(comment) && isProviderString(comment.body) ? comment.body : undefined;
    } catch {
      return undefined;
    }
  };
  const conversationCommentGone = async (octokit: Octokit, project: Project, commentId: number) => {
    try {
      await octokit.rest.issues.getComment({ owner: project.owner, repo: project.name, comment_id: commentId });
      return false;
    } catch (error) {
      return statusOf(error) === 404;
    }
  };

  const REVIEW_THREAD_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread { isResolved pullRequest { number repository { name owner { login } } } }
  }
}`;
  const readReviewThread = async (octokit: Octokit, threadId: string, project: Project, number: number) => {
    let data: unknown;
    try {
      data = await octokit.graphql(REVIEW_THREAD_QUERY, { id: threadId });
    } catch (error) {
      const fields = failureFields(error);
      if (!isArray(fields?.errors)) throw error;
      data = fields?.data;
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
  };
  const replyToReviewThread = async (octokit: Octokit, threadId: string, body: string) => {
    let data: unknown;
    try {
      data = await octokit.graphql(
        'mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }',
        { threadId, body },
      );
    } catch (error) {
      throw graphqlRejection(error);
    }
    if (!isProviderString(gqlPath(data, 'addPullRequestReviewThreadReply', 'comment', 'id'))) throw invalidProviderPayload('GitHub returned an invalid reply');
    return {};
  };
  const PENDING_COMMENT_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewComment { state viewerDidAuthor pullRequest { number repository { name owner { login } } } }
  }
}`;
  const requirePendingComment = async (octokit: Octokit, commentId: string, project: Project, number: number) => {
    let data: unknown;
    try {
      data = await octokit.graphql(PENDING_COMMENT_QUERY, { id: commentId });
    } catch (error) {
      const fields = failureFields(error);
      if (!isArray(fields?.errors)) throw error;
      data = fields?.data;
    }
    const node = fieldAt(data, 'node');
    const pull = fieldAt(node, 'pullRequest');
    const repository = fieldAt(pull, 'repository');
    const login = gqlPath(repository, 'owner', 'login');
    const name = fieldAt(repository, 'name');
    if (fieldAt(node, '__typename') !== 'PullRequestReviewComment' || fieldAt(node, 'state') !== 'PENDING' || fieldAt(node, 'viewerDidAuthor') !== true
      || fieldAt(requireField(pull, 'pullRequest'), 'number') !== number
      || !isProviderString(login) || !isProviderString(name)
      || login.toLowerCase() !== project.owner.toLowerCase()
      || name.toLowerCase() !== project.name.toLowerCase()) {
      throw mutationError('Review comment is not a draft of yours on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    }
  };
  const pendingReview = async (octokit: Octokit, { pendingReviewId, pullRequestId }: GitHubMutationTarget, headSha: string | undefined) => {
    if (pendingReviewId) return pendingReviewId;
    const data = await graphqlWrite(
      octokit,
      'mutation($pullRequestId: ID!, $commitOID: GitObjectID!) { addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) { pullRequestReview { id } } }',
      { pullRequestId, commitOID: headSha },
    );
    const id = gqlPath(data, 'addPullRequestReview', 'pullRequestReview', 'id');
    if (!isProviderString(id) || !id) throw invalidProviderPayload('GitHub returned an invalid review');
    return id;
  };
  const addReviewComment = async (octokit: Octokit, providerTarget: GitHubMutationTarget, headSha: string | undefined, { path, side, startLine, line, body }: Pick<GitHubMutationInput, 'path' | 'side' | 'startLine' | 'line' | 'body'>) => {
    const pullRequestReviewId = await pendingReview(octokit, providerTarget, headSha);
    const diffSide = side === 'old' ? 'LEFT' : 'RIGHT';
    const position = line === undefined
      ? { subjectType: 'FILE' }
      : { subjectType: 'LINE', line, side: diffSide, startLine, startSide: startLine === undefined ? undefined : diffSide };
    const data = await graphqlWrite(
      octokit,
      'mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }',
      { input: { pullRequestReviewId, path, body, ...position } },
    );
    if (!isProviderString(gqlPath(data, 'addPullRequestReviewThread', 'thread', 'id'))) throw invalidProviderPayload('GitHub returned an invalid review comment');
    return {};
  };
  const updateReviewComment = async (octokit: Octokit, commentId: string, body: string | undefined) => {
    const data = await graphqlWrite(
      octokit,
      'mutation($commentId: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) { pullRequestReviewComment { id } } }',
      { commentId, body },
    );
    if (gqlPath(data, 'updatePullRequestReviewComment', 'pullRequestReviewComment', 'id') !== commentId) throw invalidProviderPayload('GitHub returned an invalid review comment');
    return {};
  };
  const deleteReviewComment = async (octokit: Octokit, commentId: string) => {
    await graphqlWrite(
      octokit,
      'mutation($commentId: ID!) { deletePullRequestReviewComment(input: { id: $commentId }) { clientMutationId } }',
      { commentId },
    );
    return {};
  };
  const discardReview = async (octokit: Octokit, pendingReviewId: GitHubMutationTarget['pendingReviewId']) => {
    await graphqlWrite(
      octokit,
      'mutation($id: ID!) { deletePullRequestReview(input: { pullRequestReviewId: $id }) { clientMutationId } }',
      { id: pendingReviewId },
    );
    return {};
  };
  const submitReview = async (octokit: Octokit, pendingReviewId: GitHubMutationTarget['pendingReviewId'], event: string, body: string | undefined) => {
    const data = await graphqlWrite(
      octokit,
      'mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) { pullRequestReview { state } } }',
      { id: pendingReviewId, event, body: body ?? null },
    );
    return gqlPath(data, 'submitPullRequestReview', 'pullRequestReview', 'state');
  };
  const setReviewThreadResolved = async (octokit: Octokit, threadId: string, resolved: boolean) => {
    const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    let data: unknown;
    try {
      data = await octokit.graphql(`mutation($threadId: ID!) { ${field}(input: { threadId: $threadId }) { thread { isResolved } } }`, { threadId });
    } catch (error) {
      throw graphqlRejection(error);
    }
    if (gqlPath(data, field, 'thread', 'isResolved') !== resolved) throw invalidProviderPayload('GitHub returned an invalid thread state');
    return {};
  };
  const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) { id number title body closed labels(first: 100) { nodes { id name } } }
  }
}`;
  const graphqlWrite = async <Variables extends NonNullable<unknown>>(octokit: Octokit, query: string, variables: Variables) => {
    try {
      return await octokit.graphql<unknown>(query, variables);
    } catch (error) {
      throw graphqlRejection(error);
    }
  };
  const readDiscussion = async (octokit: Octokit, project: Project, number: number | undefined): Promise<Discussion> => {
    let data: unknown;
    try {
      data = await octokit.graphql(DISCUSSION_QUERY, { owner: project.owner, name: project.name, number });
    } catch (error) {
      const fields = failureFields(error);
      if (!isArray(fields?.errors)) throw error;
      data = fields?.data;
    }
    const discussion = gqlPath(data, 'repository', 'discussion');
    const id = fieldAt(discussion, 'id');
    if (!isPlainObject(discussion) || fieldAt(discussion, 'number') !== number || !isProviderString(id) || !id) {
      throw mutationError('GitHub discussion was not found', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    }
    const labels = requireProviderArray(gqlPath(discussion, 'labels', 'nodes'), 'GitHub returned an invalid label list');
    if (!isDiscussionLabelList(labels)) {
      throw invalidProviderPayload('GitHub returned an invalid label list');
    }
    const title = fieldAt(discussion, 'title');
    const body = fieldAt(discussion, 'body');
    return {
      id,
      closed: fieldAt(discussion, 'closed') === true,
      labels,
      title: isProviderString(title) ? title : undefined,
      body: isProviderString(body) ? body : undefined,
    };
  };
  const DISCUSSION_COMMENT_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on DiscussionComment { isAnswer body replyTo { id } discussion { number repository { name owner { login } } } }
  }
}`;
  const readDiscussionCommentNode = async (octokit: Octokit, commentId: string) => {
    let data: unknown;
    let errors: unknown[] | undefined;
    try {
      data = await octokit.graphql(DISCUSSION_COMMENT_QUERY, { id: commentId });
    } catch (error) {
      const fields = failureFields(error);
      if (!isArray(fields?.errors)) throw error;
      data = fields?.data;
      errors = fields.errors;
    }
    if (!isPlainObject(data) || !Object.hasOwn(data, 'node')) return { status: 'unknown' as const };
    const node = fieldAt(data, 'node');
    if (node !== null) return { status: 'found' as const, node };
    return errors?.length ? { status: 'unknown' as const } : { status: 'absent' as const };
  };
  const discussionCommentGone = async (octokit: Octokit, commentId: string) => {
    try {
      return (await readDiscussionCommentNode(octokit, commentId)).status === 'absent';
    } catch {
      return false;
    }
  };
  const readDiscussionComment = async (octokit: Octokit, commentId: string, project: Project, number: number | undefined) => {
    const read = await readDiscussionCommentNode(octokit, commentId);
    if (read.status === 'unknown') throw invalidProviderPayload('GitHub did not answer the comment read');
    const node = read.status === 'found' ? read.node : null;
    const discussion = fieldAt(node, 'discussion');
    const repository = fieldAt(discussion, 'repository');
    const login = gqlPath(repository, 'owner', 'login');
    const name = fieldAt(repository, 'name');
    if (fieldAt(node, '__typename') !== 'DiscussionComment' || fieldAt(requireField(discussion, 'discussion'), 'number') !== number
      || !isProviderString(login) || !isProviderString(name)
      || login.toLowerCase() !== project.owner.toLowerCase()
      || name.toLowerCase() !== project.name.toLowerCase()) {
      throw mutationError('Comment is not on this discussion', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
    }
    return { isAnswer: fieldAt(node, 'isAnswer') === true, reply: isPlainObject(fieldAt(node, 'replyTo')) };
  };
  const commentOnDiscussion = async (octokit: Octokit, discussionId: string, body: string | undefined, replyTo: string | undefined) => {
    const data = await graphqlWrite(
      octokit,
      'mutation($discussionId: ID!, $body: String!, $replyToId: ID) { addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) { comment { id } } }',
      { discussionId, body, replyToId: replyTo ?? null },
    );
    if (!isProviderString(gqlPath(data, 'addDiscussionComment', 'comment', 'id'))) throw invalidProviderPayload('GitHub returned an invalid comment');
    return {};
  };
  const setDiscussionState = async (octokit: Octokit, discussionId: string, state: ItemState, reason: GitHubMutationInput['reason']) => {
    const data = state === 'closed'
      ? await graphqlWrite(
        octokit,
        'mutation($discussionId: ID!, $reason: DiscussionCloseReason!) { closeDiscussion(input: { discussionId: $discussionId, reason: $reason }) { discussion { closed } } }',
        { discussionId, reason: fieldAt(DISCUSSION_CLOSE_REASONS, String(reason)) },
      )
      : await graphqlWrite(octokit, 'mutation($discussionId: ID!) { reopenDiscussion(input: { discussionId: $discussionId }) { discussion { closed } } }', { discussionId });
    const closed = gqlPath(data, state === 'closed' ? 'closeDiscussion' : 'reopenDiscussion', 'discussion', 'closed');
    if (closed !== (state === 'closed')) throw invalidProviderPayload('GitHub returned an unexpected state');
    return { state };
  };
  const updateDiscussionText = async (octokit: Octokit, discussionId: string, title: string, body: string | undefined) => {
    const data = body === undefined
      ? await graphqlWrite(
        octokit,
        'mutation($discussionId: ID!, $title: String!) { updateDiscussion(input: { discussionId: $discussionId, title: $title }) { discussion { id title } } }',
        { discussionId, title },
      )
      : await graphqlWrite(
        octokit,
        'mutation($discussionId: ID!, $title: String!, $body: String!) { updateDiscussion(input: { discussionId: $discussionId, title: $title, body: $body }) { discussion { id title body } } }',
        { discussionId, title, body },
      );
    const updated = gqlPath(data, 'updateDiscussion', 'discussion');
    const id = fieldAt(updated, 'id');
    if (!isProviderString(id) || id !== discussionId || fieldAt(updated, 'title') !== title
      || (body !== undefined && fieldAt(updated, 'body') !== body)) {
      throw invalidProviderPayload('GitHub returned an invalid discussion update');
    }
    return {};
  };
  const setDiscussionAnswer = async (octokit: Octokit, commentId: string, answer: boolean) => {
    const field = answer ? 'markDiscussionCommentAsAnswer' : 'unmarkDiscussionCommentAsAnswer';
    const data = await graphqlWrite(octokit, `mutation($id: ID!) { ${field}(input: { id: $id }) { discussion { id } } }`, { id: commentId });
    if (!isProviderString(gqlPath(data, field, 'discussion', 'id'))) throw invalidProviderPayload('GitHub returned an invalid answer');
    return {};
  };
  const setDiscussionLabels = async (octokit: Octokit, project: Project, discussion: Discussion, labels: string[]) => {
    let ids: string[] = [];
    if (labels.length > 0) {
      const variables: LabelVariables = { owner: project.owner, name: project.name };
      const selections = labels.map((label, index) => {
        variables[`l${index}`] = label;
        return `l${index}: label(name: $l${index}) { id name }`;
      });
      const declarations = labels.map((_label, index) => `$l${index}: String!`).join(', ');
      const data = await graphqlWrite(octokit, `query($owner: String!, $name: String!, ${declarations}) { repository(owner: $owner, name: $name) { ${selections.join(' ')} } }`, variables);
      ids = labels.map((label, index) => {
        const id = gqlPath(data, 'repository', `l${index}`, 'id');
        if (!isProviderString(id)) throw mutationError(`Label ${label} does not exist in this repository`, 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
        return id;
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
        if (!add.length) throw error;
        throw new Error('GitHub changed only part of the labels', { cause: error });
      }
    }
    return {};
  };
  const setLabels = async (octokit: Octokit, project: Project, number: number, labels: string[]) => {
    const response = await rejected(() => octokit.rest.issues.setLabels({ owner: project.owner, repo: project.name, issue_number: number, labels }));
    requireProviderArray(fieldAt(response, 'data'), 'GitHub returned an invalid label list');
    return {};
  };
  const requestedReviewers = async (octokit: Octokit, project: Project, number: number) => {
    const response = await octokit.rest.pulls.listRequestedReviewers({ owner: project.owner, repo: project.name, pull_number: number });
    const users = response?.data?.users;
    if (!Array.isArray(users) || users.some((user) => !isProviderString(user?.login))) {
      throw invalidProviderPayload('GitHub returned an invalid reviewer list');
    }
    return users.map((user) => user.login);
  };
  const setReviewers = async (octokit: Octokit, project: Project, number: number, reviewers: string[]) => {
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
  const setState = async (update: () => Promise<{ data?: { state?: string } }>, state: ItemState) => {
    const response = await rejected(update);
    if (response?.data?.state !== state) throw invalidProviderPayload('GitHub returned an unexpected state');
    return { state };
  };

  const reconcileCreate = async (octokit: ReturnType<GitHubMutationOptions['octokitOf']>, expectedProject: Project, sourceProject: Project, head: string | undefined, base: string | undefined): Promise<MutationCompletion> => {
    const params = {
      owner: expectedProject.owner, repo: expectedProject.name, state: 'all' as const, head: `${sourceProject.owner}:${head}`, base, per_page: 100,
    };
    const response = await octokit.rest.pulls.list(params);
    const candidates = requireProviderArray(response?.data, 'GitHub returned an invalid pull request list')
      .map((pr) => requireMutationPullRequest(pr, 'GitHub returned an invalid pull request', octokit))
      .filter((pr) => pr.head.ref === head && pr.base.ref === base)
      .filter((pr) => sameProject(pullTargetProject(pr), expectedProject))
      .filter((pr) => pr.head.repo && sameProject({ owner: pr.head.repo.owner.login, name: pr.head.repo.name }, sourceProject));
    if (candidates.length !== 1) return unknownOutcome();
    const found = requireField(candidates[0], 'candidate');
    const stacked = sameProject(sourceProject, expectedProject)
      ? await settleStack(octokit, expectedProject, found.number, base, found.base?.repo?.default_branch)
      : undefined;
    return { state: 'succeeded', result: stacked === undefined ? { number: found.number } : { number: found.number, stacked } };
  };

  const reconcileExisting = async (octokit: ReturnType<GitHubMutationOptions['octokitOf']>, operation: string, target: MutationTarget, input: GitHubMutationInput): Promise<MutationCompletion> => {
    if (['comment', 'review', 'issue-comment', 'thread-reply', 'discussion-comment'].includes(operation)) return unknownOutcome();
    if (REVIEW_DRAFT_OPERATIONS.has(operation)) return unknownOutcome();
    const project = target.project;
    if (operation === 'discussion-update') {
      const discussion = await readDiscussion(octokit, project, target.number);
      if (discussion.title === undefined || discussion.body === undefined) return unknownOutcome();
      const matches = discussion.title === input.title && (input.body === undefined || discussion.body === input.body);
      return matches ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'issue-update') {
      const current = await octokit.rest.issues.get({ owner: project.owner, repo: project.name, issue_number: target.number });
      const issue = current?.data;
      if (!isPlainObject(issue) || !isProviderString(issue.title)) return unknownOutcome();
      const issueBody = issue.body ?? '';
      const matches = issue.title === input.title && (input.body === undefined || issueBody === input.body);
      return matches ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (CONVERSATION_COMMENT_KINDS.has(operation)) {
      if (operation.endsWith('-update')) {
        const body = await readConversationCommentBody(octokit, project, restId(input.commentId));
        return body === input.body ? { state: 'succeeded', result: {} } : unknownOutcome();
      }
      return (await conversationCommentGone(octokit, project, restId(input.commentId)))
        ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'discussion-comment-update') {
      try {
        const read = await readDiscussionCommentNode(octokit, graphqlId(input.commentId));
        return read.status === 'found' && fieldAt(read.node, 'body') === input.body ? { state: 'succeeded', result: {} } : unknownOutcome();
      } catch {
        return unknownOutcome();
      }
    }
    if (operation === 'discussion-comment-delete') {
      return (await discussionCommentGone(octokit, graphqlId(input.commentId))) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'discussion-state') {
      const discussion = await readDiscussion(octokit, project, target.number);
      const state = discussion.closed ? 'closed' : 'open';
      return state === input.state ? { state: 'succeeded', result: { state } } : definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    }
    if (operation === 'discussion-answer') {
      const comment = await readDiscussionComment(octokit, graphqlId(input.commentId), project, target.number);
      return comment.isAnswer === input.answer ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'discussion-labels') {
      const names = (await readDiscussion(octokit, project, target.number)).labels.map((label) => label.name);
      return sameNames(names, requireField(input.labels, 'labels')) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'thread-resolve') {
      const thread = await readReviewThread(octokit, requireField(input.threadId, 'threadId'), project, requireField(target.number, 'number'));
      return thread.isResolved === input.resolved ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'labels' || operation === 'issue-labels') {
      const current = await octokit.rest.issues.listLabelsOnIssue({ owner: project.owner, repo: project.name, issue_number: requireField(target.number, 'number'), per_page: 100 });
      const names = requireProviderArray(current?.data, 'GitHub returned an invalid label list').map((label) => fieldAt(label, 'name'));
      return names.every(isProviderString) && sameNames(names, requireField(input.labels, 'labels')) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'reviewers') {
      return sameNames(await requestedReviewers(octokit, project, requireField(target.number, 'number')), requireField(input.reviewers, 'reviewers')) ? { state: 'succeeded', result: {} } : unknownOutcome();
    }
    if (operation === 'issue-assignees') return reconcileAssignees(octokit, target, input, { invalidProviderPayload, sameNames, unknownOutcome });
    if (operation === 'issue-state') return reconcileIssueState(octokit, target, input, { unknownOutcome, definiteFailure });
    const current = await octokit.rest.pulls.get({ owner: project.owner, repo: project.name, pull_number: requireField(target.number, 'number') });
    const pr = requireMutationPullRequest(current?.data, 'GitHub returned an invalid pull request', octokit);
    if (operation === 'merge') {
      if (pr.merged === true || isProviderString(pr.merged_at)) return { state: 'succeeded', result: { merged: true } };
      const { pull } = await readWaitingMerge(octokit, project, target);
      if (input.cancel) return !pull.isInMergeQueue && !pull.autoMergeRequest
        ? { state: 'succeeded', result: { merged: false, outcome: 'cancelled' } } : unknownOutcome();
      if (pull.isInMergeQueue) return { state: 'succeeded', result: { merged: false, outcome: 'queued' } };
      if (pull.autoMergeRequest) return { state: 'succeeded', result: { merged: false, outcome: 'auto-merge' } };
    } else if (operation === 'state') {
      if (pr.state === input.state) return { state: 'succeeded', result: { state: pr.state } };
      if (pr.state === 'open' || pr.state === 'closed') return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    } else if (operation === 'ready') {
      if (pr.draft === false) return { state: 'succeeded', result: { ready: true } };
      if (pr.draft === true && pr.state === 'open') return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    } else if (operation === 'draft') {
      if (pr.draft === true) return { state: 'succeeded', result: { draft: true } };
      if (pr.draft === false && pr.state === 'open') return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
    }
    return unknownOutcome();
  };

  const resolveNetworkProjects = async (octokit: Octokit, context: ProviderMutationContext) => {
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

  const baseTarget = (context: ProviderMutationContext, project: Project) => ({
    repositoryId: context.repositoryId,
    bindingRevision: context.bindingRevision,
    primaryRemote: context.primaryRemote,
    project: { id: `${project.owner}/${project.name}`, owner: project.owner, name: project.name },
  });

  const resolveNew = async (octokit: ReturnType<GitHubMutationOptions['octokitOf']>, context: ProviderMutationContext, operation: string, input: GitHubMutationInput): Promise<MutationStep['resolved']> => {
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
        target: { ...baseTarget(context, expectedProject), head: requireField(input.head, 'head'), base: requireField(input.base, 'base') },
      };
    }
    const expected = context.target;
    const number = requireField(expected.number, 'number');
    if (DISCUSSION_KINDS.has(operation)) {
      if (expected.head !== undefined || expected.base !== undefined || expected.headSha !== undefined) {
        throw mutationError('Discussion target is invalid');
      }
      const discussion = await readDiscussion(octokit, expectedProject, number);
      const namesComment = operation === 'discussion-answer'
        || operation === 'discussion-comment-update' || operation === 'discussion-comment-delete';
      if (namesComment) {
        await readDiscussionComment(octokit, graphqlId(input.commentId), expectedProject, number);
      }
      if (operation === 'discussion-comment' && input.replyTo !== undefined) {
        const replyTo = await readDiscussionComment(octokit, input.replyTo, expectedProject, number);
        if (replyTo.reply) {
          throw mutationError('A reply answers a comment, not another reply', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
        }
      }
      return { providerTarget: { discussion }, target: { ...baseTarget(context, expectedProject), number } };
    }
    if (ISSUE_KINDS.has(operation) && !operation.startsWith('change-request-')) {
      if (expected.head !== undefined || expected.base !== undefined || expected.headSha !== undefined) {
        throw mutationError('Issue target is invalid');
      }
      const issue = (await octokit.rest.issues.get({ owner: expectedProject.owner, repo: expectedProject.name, issue_number: number }))?.data;
      if (!isPlainObject(issue) || issue.number !== expected.number) throw invalidProviderPayload('GitHub returned an invalid issue');
      if (issue.pull_request) throw mutationError('GitHub issue is a pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      if (CONVERSATION_COMMENT_KINDS.has(operation)) {
        await requireConversationComment(octokit, restId(input.commentId), expectedProject, issue.number);
      }
      return { providerTarget: {}, target: { ...baseTarget(context, expectedProject), number: issue.number } };
    }
    const response = await octokit.rest.pulls.get({ owner: expectedProject.owner, repo: expectedProject.name, pull_number: number });
    const pr = requireMutationPullRequest(response?.data, 'GitHub returned an invalid pull request', octokit);
    if (!sameProject(pullTargetProject(pr), expectedProject) || !targetMatches(expected, pr)) {
      throw mutationError('GitHub pull request no longer matches the mutation target', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', 409);
    }
    const target = { ...baseTarget(context, expectedProject), number: pr.number, head: pr.head.ref, base: pr.base.ref, headSha: pr.head.sha };
    if (operation === 'thread-reply' || operation === 'thread-resolve') {
      await readReviewThread(octokit, requireField(input.threadId, 'threadId'), expectedProject, target.number);
    }
    if (operation === 'review-comment-update' || operation === 'review-comment-delete') {
      await requirePendingComment(octokit, graphqlId(input.commentId), expectedProject, target.number);
    }
    if (CONVERSATION_COMMENT_KINDS.has(operation)) {
      await requireConversationComment(octokit, restId(input.commentId), expectedProject, target.number);
    }
    if (operation === 'review' || operation === 'review-comment' || operation === 'review-discard') {
      const pending = await readPendingReview({ octokit, owner: expectedProject.owner, repo: expectedProject.name, number: target.number });
      if (operation === 'review-discard' && !pending) {
        throw mutationError('There is no review draft on this pull request', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      }
      if (operation === 'review' && input.verdict !== 'comment' && pending && pending.commit !== pr.head.sha) {
        throw mutationError('This review draft was started on an older commit. Send it as a comment, then give your verdict.', 'SOURCE_CONTROL_MUTATION_REJECTED', 409);
      }
      return { providerTarget: { pendingReviewId: pending?.id ?? null, pullRequestId: pr.node_id }, target };
    }
    if (operation === 'ready' || operation === 'draft') {
      const already = operation === 'ready' ? pr.draft === false : pr.draft === true;
      const nodeId = optionalText(pr.node_id, 'pull request node id', true);
      if (!already && !nodeId) throw invalidProviderPayload('GitHub returned an invalid pull request node id');
      return { providerTarget: { already, nodeId: nodeId ?? null }, target };
    }
    return { providerTarget: {}, target };
  };

  const performOperation = async (octokit: ReturnType<GitHubMutationOptions['octokitOf']>, operation: string, input: GitHubMutationInput, { providerTarget, target }: MutationStep['resolved']): Promise<MutationResult> => {
    const project = target.project;
    const number = () => requireField(target.number, 'number');
    const title = () => requireField(input.title, 'title');
    const body = () => requireField(input.body, 'body');
    const labels = () => requireField(input.labels, 'labels');
    const discussion = () => requireField(providerTarget.discussion, 'discussion');
    const threadId = () => requireField(input.threadId, 'threadId');
    const state = () => requireField(input.state, 'state');
    switch (operation) {
      case 'create': {
        const sourceProject = requireField(providerTarget.sourceProject, 'sourceProject');
        const head = requireField(input.head, 'head');
        const base = requireField(input.base, 'base');
        const createInput: Rest['pulls']['create']['parameters'] = {
          owner: project.owner,
          repo: project.name,
          title: title(),
          head: sameProject(sourceProject, project) ? head : `${sourceProject.owner}:${head}`,
          base,
        };
        if (input.body !== undefined) createInput.body = input.body;
        if (input.draft !== undefined) createInput.draft = input.draft;
        const response = await octokit.rest.pulls.create(createInput);
        const created = requireMutationPullRequest(response?.data, 'GitHub returned an invalid created pull request', octokit);
        const createdSource = created.head.repo ? { owner: created.head.repo.owner.login, name: created.head.repo.name } : null;
        if (!targetMatches({ number: created.number, head, base }, created)
          || !sameProject(pullTargetProject(created), project)
          || !sameProject(createdSource, sourceProject)) {
          throw invalidProviderPayload('GitHub returned a created pull request with an unexpected target');
        }
        const stacked = sameProject(sourceProject, project)
          ? await stackOnParent(octokit, project, created.number, base, created.base?.repo?.default_branch)
          : undefined;
        return stacked === undefined ? { number: created.number } : { number: created.number, stacked };
      }
      case 'update': {
        const updateInput: Rest['pulls']['update']['parameters'] = { owner: project.owner, repo: project.name, pull_number: number(), title: title() };
        if (input.body !== undefined) updateInput.body = input.body;
        const updated = requireMutationPullRequest((await octokit.rest.pulls.update(updateInput))?.data, 'GitHub returned an invalid updated pull request', octokit);
        if (!sameProject(pullTargetProject(updated), project) || !targetMatches(target, updated)) {
          throw invalidProviderPayload('GitHub returned an updated pull request with an unexpected target');
        }
        return {};
      }
      case 'merge':
        if (input.cancel) {
          try { return await cancelWaitingMerge(octokit, project, target); }
          catch (error) { throw graphqlRejection(error); }
        }
        return mergePullRequest(octokit, project, target, requireField(input.method, 'method'));
      case 'labels':
      case 'issue-labels':
        return setLabels(octokit, project, number(), labels());
      case 'reviewers':
        return setReviewers(octokit, project, number(), requireField(input.reviewers, 'reviewers'));
      case 'state':
        return setState(() => octokit.rest.pulls.update({ owner: project.owner, repo: project.name, pull_number: number(), state: state() }), state());
      case 'issue-assignees':
        return performAssignees(octokit, project, target, input, { rejected, sameNames, invalidProviderPayload });
      case 'issue-state':
        return performIssueState(octokit, project, target, input, { setState, invalidProviderPayload });
      case 'issue-update': {
        const updateInput: Rest['issues']['update']['parameters'] = { owner: project.owner, repo: project.name, issue_number: number(), title: title() };
        if (input.body !== undefined) updateInput.body = input.body;
        const updated = fieldAt(await rejected(() => octokit.rest.issues.update(updateInput)), 'data');
        const updatedBody = fieldAt(updated, 'body');
        if (!isPlainObject(updated) || fieldAt(updated, 'number') !== target.number || fieldAt(updated, 'title') !== input.title
          || (input.body !== undefined && (updatedBody === null ? '' : updatedBody) !== input.body)) {
          throw invalidProviderPayload('GitHub returned an invalid issue update');
        }
        return {};
      }
      case 'discussion-update':
        return updateDiscussionText(octokit, discussion().id, title(), input.body);
      case 'comment':
      case 'issue-comment':
        return postComment(octokit, project, number(), body());
      case 'change-request-comment-update':
      case 'issue-comment-update': {
        const updated = fieldAt(await rejected(() => octokit.rest.issues.updateComment({
          owner: project.owner, repo: project.name, comment_id: restId(input.commentId), body: body(),
        })), 'data');
        if (!isPlainObject(updated) || fieldAt(updated, 'body') !== input.body) throw invalidProviderPayload('GitHub returned an invalid comment');
        return {};
      }
      case 'change-request-comment-delete':
      case 'issue-comment-delete':
        await rejected(() => octokit.rest.issues.deleteComment({ owner: project.owner, repo: project.name, comment_id: restId(input.commentId) }));
        return {};
      case 'discussion-comment-update': {
        const data = await graphqlWrite(
          octokit,
          'mutation($commentId: ID!, $body: String!) { updateDiscussionComment(input: { commentId: $commentId, body: $body }) { comment { id body } } }',
          { commentId: input.commentId, body: input.body },
        );
        const updated = gqlPath(data, 'updateDiscussionComment', 'comment');
        if (!isPlainObject(updated) || fieldAt(updated, 'id') !== input.commentId || fieldAt(updated, 'body') !== input.body) {
          throw invalidProviderPayload('GitHub returned an invalid comment');
        }
        return {};
      }
      case 'discussion-comment-delete':
        await graphqlWrite(octokit, 'mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { clientMutationId } }', { id: input.commentId });
        return {};
      case 'thread-reply':
        return replyToReviewThread(octokit, threadId(), body());
      case 'thread-resolve':
        return setReviewThreadResolved(octokit, threadId(), requireField(input.resolved, 'resolved'));
      case 'discussion-comment':
        return commentOnDiscussion(octokit, discussion().id, input.body, input.replyTo);
      case 'discussion-state':
        return setDiscussionState(octokit, discussion().id, state(), input.reason);
      case 'discussion-answer':
        return setDiscussionAnswer(octokit, graphqlId(input.commentId), requireField(input.answer, 'answer'));
      case 'discussion-labels':
        return setDiscussionLabels(octokit, project, discussion(), labels());
      case 'review-comment':
        return addReviewComment(octokit, providerTarget, target.headSha, input);
      case 'review-comment-update':
        return updateReviewComment(octokit, graphqlId(input.commentId), input.body);
      case 'review-comment-delete':
        return deleteReviewComment(octokit, graphqlId(input.commentId));
      case 'review-discard':
        return discardReview(octokit, providerTarget.pendingReviewId);
      case 'review': {
        const isReviewEvent = (value: unknown): value is typeof REVIEW_EVENTS[keyof typeof REVIEW_EVENTS] =>
          value === REVIEW_EVENTS.approve || value === REVIEW_EVENTS['request-changes'] || value === REVIEW_EVENTS.comment;
        const entry = fieldAt(REVIEW_EVENTS, String(input.verdict));
        if (!isReviewEvent(entry)) throw new TypeError('GitHub review event is unavailable');
        const { event, state } = entry;
        if (providerTarget.pendingReviewId) {
          if (await submitReview(octokit, providerTarget.pendingReviewId, event, input.body) !== state) {
            throw invalidProviderPayload('GitHub returned an invalid review');
          }
          return { commented: input.body !== undefined };
        }
        if (input.verdict === 'comment' && input.body === undefined) {
          throw mutationError('A review with no comments needs text', 'SOURCE_CONTROL_MUTATION_REJECTED', 422);
        }
        const reviewInput: Rest['pulls']['createReview']['parameters'] = {
          owner: project.owner,
          repo: project.name,
          pull_number: number(),
          commit_id: requireField(target.headSha, 'headSha'),
          event,
        };
        if (input.body !== undefined) reviewInput.body = input.body;
        const response = await rejected(() => octokit.rest.pulls.createReview(reviewInput));
        if (gqlPath(response, 'data', 'state') !== state) {
          throw invalidProviderPayload('GitHub returned an invalid review');
        }
        return { commented: input.body !== undefined };
      }
      case 'ready': {
        if (!providerTarget.already) {
          const ready = await octokit.graphql<unknown>(
            `mutation($pullRequestId: ID!) {\n  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {\n    pullRequest {\n      id\n      isDraft\n    }\n  }\n}`,
            { pullRequestId: providerTarget.nodeId },
          );
          const result = gqlPath(ready, 'markPullRequestReadyForReview', 'pullRequest');
          if (!isPlainObject(result) || fieldAt(result, 'id') !== providerTarget.nodeId || fieldAt(result, 'isDraft') !== false) {
            throw invalidProviderPayload('GitHub returned an invalid ready-for-review result');
          }
        }
        return { ready: true };
      }
      case 'draft': {
        if (!providerTarget.already) {
          const draft = await octokit.graphql<unknown>(
            `mutation($pullRequestId: ID!) {\n  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {\n    pullRequest {\n      id\n      isDraft\n    }\n  }\n}`,
            { pullRequestId: providerTarget.nodeId },
          );
          const result = gqlPath(draft, 'convertPullRequestToDraft', 'pullRequest');
          if (!isPlainObject(result) || fieldAt(result, 'id') !== providerTarget.nodeId || fieldAt(result, 'isDraft') !== true) {
            throw invalidProviderPayload('GitHub returned an invalid convert-to-draft result');
          }
        }
        return { draft: true };
      }
      default:
        throw mutationError('Mutation kind is invalid');
    }
  };

  return Object.freeze({
    routes: Object.freeze(Object.keys(ROUTE_OPERATIONS)),
    prepare: ({ route, input, context, actor, credential }: MutationPreparation) => {
      const operation = fieldAt(ROUTE_OPERATIONS, route);
      if (!operation) throw mutationError('Source control mutation is unsupported');
      if (!isProviderString(operation)) throw mutationError('Mutation kind is invalid');
      const normalized = normalizeOperation(operation, input ?? {}, context, actor, credential, descriptor.limits);
      return { kind: recordKind(operation), input: normalized.input, digest: normalized.digest };
    },
    resolveTarget: async ({ session, context, kind, input, replayOf }: MutationResolution): Promise<MutationStep['resolved']> => {
      const operation = operationOf(kind);
      const octokit = octokitOf(session);
      if (replayOf) {
        if (operation !== 'create') return { providerTarget: {}, target: replayOf.target };
        const sourceRepo = (await resolveRepo(context.directory, input.headRemote))?.repo;
        return { providerTarget: { sourceProject: sourceRepo ? repoProject(sourceRepo) : null }, target: replayOf.target };
      }
      return rejected(() => resolveNew(octokit, context, operation, input));
    },
    afterSuccess: async ({ session, target }: { session: ProviderSession; target: MutationTarget }) => {
      onSucceeded({ session, target });
      await invalidatePulls(target.project.owner, target.project.name, octokitOf(session));
    },
    perform: async ({ session, kind, input, resolved }: MutationStep) => {
      const operation = operationOf(kind);
      return performOperation(octokitOf(session), operation, input, resolved);
    },
    reconcile: async ({ session, kind, input, resolved }: MutationStep) => {
      const operation = operationOf(kind);
      const octokit = octokitOf(session);
      const { target, providerTarget } = resolved;
      return operation === 'create'
        ? providerTarget.sourceProject
          ? await reconcileCreate(octokit, target.project, providerTarget.sourceProject, target.head, target.base)
          : unknownOutcome()
        : await reconcileExisting(octokit, operation, target, input);
    },
    classifyError: (cause: unknown) => {
      const error = failureFields(cause);
      const status = statusOf(error);
      if (error && isSourceControlInteger(status) && status >= 400 && status <= 499) {
        if (!Number.isSafeInteger(error.status)) error.status = status;
        if (!isProviderString(error.code)) error.code = 'GITHUB_MUTATION_REJECTED';
        return 'failed';
      }
      return 'outcome-unknown';
    },
    presentError: (cause: unknown) => {
      const failure = failureFields(cause);
      const error = failureFields(failure?.response ? providerRejection(cause) : cause);
      const status = isSourceControlInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const code = isProviderString(error?.code) && error.code ? error.code : 'GITHUB_MUTATION_FAILED';
      const ownMessage = code.startsWith('SOURCE_CONTROL_') || code.startsWith('INVALID_SOURCE_CONTROL_');
      if (!ownMessage && status !== 401) console.warn(`GitHub mutation failed: ${status} ${code} ${error?.name ?? 'unknown'}`);
      const message = ownMessage ? error?.message : status === 401 ? 'GitHub account is unavailable' : 'GitHub mutation failed';
      const body: GitHubMutationErrorBody = { error: message, code };
      if (error?.current !== undefined) body.current = error.current;
      return { status, body };
    },
  });
}
