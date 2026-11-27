import { isSourceControlObject as isPlainObject, isSourceControlString as isString, isSourceControlInteger } from './input-guards.js';
import { digestMutationInput } from './mutation-executor.js';
import { reviewDraftEntries } from './review-position.js';
import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { AccountIdentity, ProviderDescriptor } from './provider-contract.js';
import type { MutationContextInput } from './binding-service-contracts.js';

export interface StandardMutationInput {
  title?: string;
  body?: string | undefined;
  draft?: boolean;
  remote?: string;
  headRemote?: string;
  method?: string;
  verdict?: string;
  votes?: Record<string, number>;
  publishDrafts?: boolean;
  commentId?: string;
  state?: string;
  names?: string[];
  base?: string;
  expectedHeadSha?: string;
  reviewId?: string;
  message?: string;
  dismissed?: boolean;
  position?: ReturnType<typeof import('./review-position.js').reviewCommentPosition>;
  digest?: Record<string, SourceControlJson | undefined>;
  threadId?: string;
  resolved?: boolean;
}

interface MutationEntry {
  kind: string;
  normalize(input: SourceControlJsonObject, context: MutationContextInput): StandardMutationInput;
}
interface MutationEntries {
  [route: string]: MutationEntry;
}

const invalidMutationContext = (message: string) => Object.assign(new Error(message), {
  code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT',
  status: 400,
});

const requestText = (value: SourceControlJson | undefined) => (isString(value) ? value.trim() : '');

const TITLE_MAX = 256;

const VOTE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REVIEW_ID_MAX = 256;
const isControl = (char: string) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;
const isReviewId = (value: string) => value.length > 0 && value.length <= REVIEW_ID_MAX && value.trim() === value && !Array.from(value).some(isControl);
const VOTE_LIMIT = 16;
const VOTE_RANGE = 10;

const THREAD_ID_RE = /^[A-Za-z0-9_:.=-]{1,200}$/;
export const isThreadId = (value: string): boolean => THREAD_ID_RE.test(value);

const validVotes = (entries: [string, unknown][]): entries is [string, number][] =>
  !(entries.length > VOTE_LIMIT || entries.some(([label, vote]) => !VOTE_LABEL_RE.test(label)
    || !isSourceControlInteger(vote) || Math.abs(vote) > VOTE_RANGE));

const parseVotes = (value: SourceControlJson) => {
  if (!isPlainObject(value)) throw invalidMutationContext('votes are invalid');
  const entries = Object.entries(value);
  if (!validVotes(entries)) {
    throw invalidMutationContext('votes are invalid');
  }
  return Object.fromEntries(entries);
};

const VERDICTS = ['approve', 'request-changes'];

const isNameList = (value: unknown, limit: number): value is string[] => !(!Array.isArray(value) || value.length > limit
  || value.some((entry) => !isString(entry) || !entry.trim() || entry.length > 256));

const includes = <T>(values: readonly T[], value: unknown): value is T => values.some((entry) => entry === value);

export function createStandardMutations(descriptor: ProviderDescriptor) {
  const reviewDismiss = descriptor.capabilities.reviewDismiss;
  const reviewUndismiss = descriptor.capabilities.reviewUndismiss === true;
  const commentText = (value: SourceControlJson | undefined, required: boolean) => {
    if (value === undefined && !required) return undefined;
    if (!isString(value) || !value.trim() || value.length > descriptor.limits.commentMaxLength) {
      throw invalidMutationContext(`body is required and must fit a ${descriptor.label} comment`);
    }
    return value;
  };
  const nameList = (value: SourceControlJson | undefined, limit: number) => {
    if (!isNameList(value, limit)) {
      throw invalidMutationContext('labels or reviewers are invalid');
    }
    return [...new Set(value)].sort();
  };
  const mergeMethods = descriptor.capabilities.merge ? descriptor.capabilities.merge.methods : [];
  const votesHost = descriptor.capabilities.reviewModel === 'votes';
  const reviewDrafts = Boolean(descriptor.capabilities.reviewDrafts);
  const requireNumber = (context: MutationContextInput) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
  };
  const commentId = (value: SourceControlJson | undefined) => {
    if (!isString(value) || !value.trim()) throw invalidMutationContext('commentId is required');
    return value;
  };
  const threadIdOf = (value: SourceControlJson | undefined) => {
    if (!isString(value) || !THREAD_ID_RE.test(value)) throw invalidMutationContext('threadId is invalid');
    return value;
  };
  const reviewThreads = descriptor.capabilities.reviewThreads ?? {};
  const normalizeVotes = (input: SourceControlJsonObject, context: MutationContextInput) => {
    if (input.verdict !== undefined) {
      throw invalidMutationContext(`${descriptor.label} reviews are votes; update the app to review here`);
    }
    if (!context.target.number || !context.target.headSha) throw invalidMutationContext('target number and head SHA are required');
    const votes = parseVotes(input.votes ?? {});
    const publishDrafts = reviewDrafts && input.publishDrafts === true;
    if (!publishDrafts && Object.keys(votes).length === 0 && input.body === undefined) throw invalidMutationContext('a vote or a message is required');
    const text = commentText(input.body, false);
    const digest = { votes, body: text ?? null };
    return publishDrafts ? { votes, body: text, digest: { ...digest, publishDrafts } } : { votes, body: text, digest };
  };

  const entries: MutationEntries = {
    '/pr/create': {
      kind: 'change-request-create',
      normalize: (input, context) => {
        const title = requestText(input.title);
        if (!title || !context.target.head || !context.target.base) {
          throw invalidMutationContext('title, target head, and target base are required');
        }
        const normalized: StandardMutationInput & { title: string; draft: boolean } = { title, draft: input.draft === true };
        if (isString(input.body)) normalized.body = input.body;
        const remote = requestText(input.remote);
        const headRemote = requestText(input.headRemote);
        if (remote) normalized.remote = remote;
        if (headRemote) normalized.headRemote = headRemote;
        normalized.digest = {
          title, body: normalized.body ?? null, draft: normalized.draft,
          remote: normalized.remote ?? context.primaryRemote, headRemote: normalized.headRemote ?? context.primaryRemote,
        };
        return normalized;
      },
    },
    '/pr/update': {
      kind: 'change-request-update',
      normalize: (input, context) => {
        const title = requestText(input.title);
        if (!title || !context.target.number) throw invalidMutationContext('title and target number are required');
        const normalized: StandardMutationInput & { title: string } = { title };
        if (isString(input.body)) normalized.body = input.body;
        normalized.digest = { title, body: normalized.body ?? null };
        return normalized;
      },
    },
    '/pr/merge': {
      kind: 'change-request-merge',
      normalize: (input, context) => {
        if (!context.target.number || !includes(mergeMethods, input.method)) {
          throw invalidMutationContext('target number and merge method are required');
        }
        if (input.method === 'submit' && !context.target.headSha) {
          throw invalidMutationContext('target head SHA is required to submit');
        }
        return { method: input.method, digest: { method: input.method } };
      },
    },
    '/pr/ready': {
      kind: 'change-request-ready',
      normalize: (_input, context) => {
        requireNumber(context);
        return { digest: {} };
      },
    },
    '/pr/draft': {
      kind: 'change-request-draft',
      normalize: (_input, context) => {
        requireNumber(context);
        return { digest: {} };
      },
    },
    '/pr/review': {
      kind: 'change-request-review',
      normalize: (input, context) => {
        if (votesHost) return normalizeVotes(input, context);
        if (input.votes !== undefined) throw invalidMutationContext(`${descriptor.label} reviews take a verdict, not votes`);
        if (!context.target.number || !context.target.headSha || !includes([...VERDICTS, ...(reviewDrafts ? ['comment'] : [])], input.verdict)) {
          throw invalidMutationContext('target number, head SHA and review verdict are required');
        }
        const text = commentText(input.body, false);
        return { verdict: input.verdict, body: text, digest: { verdict: input.verdict, body: text ?? null } };
      },
    },
    ...reviewDraftEntries({
      commentText,
      fail: (message) => { throw invalidMutationContext(message); },
      fileComments: descriptor.capabilities.reviewDrafts?.fileComments === true,
    }),
  };
  const { baseChange, updateBranch, rebase } = descriptor.presentation.features;
  const headWrite = (kind: string): MutationEntry => ({
    kind,
    normalize: (input, context) => {
      requireNumber(context);
      const expectedHeadSha = requestText(input.expectedHeadSha);
      if (!/^[0-9a-f]{40}$/.test(expectedHeadSha)) {
        throw invalidMutationContext('expectedHeadSha is required and must be a 40-character lowercase hex SHA');
      }
      if (context.target.headSha !== undefined && context.target.headSha !== expectedHeadSha) {
        throw invalidMutationContext('expectedHeadSha does not match the target head');
      }
      return { expectedHeadSha, digest: { expectedHeadSha } };
    },
  });
  if (baseChange === true) {
    entries['/pr/base'] = {
      kind: 'change-request-base',
      normalize: (input, context) => {
        requireNumber(context);
        const base = requestText(input.base);
        if (!base || base.length > TITLE_MAX) throw invalidMutationContext(`base is required and must fit ${TITLE_MAX} characters`);
        return { base, digest: { base } };
      },
    };
  }
  if (updateBranch === true) entries['/pr/update-branch'] = headWrite('change-request-update-branch');
  if (rebase === true) entries['/pr/rebase'] = headWrite('change-request-rebase');
  if (reviewDismiss) {
    entries['/pr/review/dismiss'] = {
      kind: 'change-request-review-dismiss',
      normalize: (input, context) => {
        requireNumber(context);
        if (reviewDismiss === 'own') {
          if (input.reviewId !== undefined || input.message !== undefined) {
            throw invalidMutationContext(`${descriptor.label} reviews are withdrawn without a review id or message`);
          }
          if (input.dismissed === false) throw invalidMutationContext(`${descriptor.label} reviews cannot be undismissed`);
          return { dismissed: true, digest: { dismissed: true } };
        }
        const id = isString(input.reviewId) || Number.isSafeInteger(input.reviewId) ? String(input.reviewId) : '';
        if (!isReviewId(id)) throw invalidMutationContext('reviewId is required');
        if (input.dismissed !== undefined && input.dismissed !== true && input.dismissed !== false) {
          throw invalidMutationContext('dismissed is invalid');
        }
        const dismissed = input.dismissed !== false;
        if (!dismissed && !reviewUndismiss) throw invalidMutationContext(`${descriptor.label} reviews cannot be undismissed`);
        const text = commentText(input.message, dismissed);
        const normalized: StandardMutationInput & { reviewId: string } = { reviewId: id, dismissed };
        if (text !== undefined) normalized.message = text;
        normalized.digest = { reviewId: id, dismissed, message: text ?? null };
        return normalized;
      },
    };
  }
  for (const [route, kind] of [['/pr/comment', 'change-request-comment'], ['/issues/comment', 'issue-comment']] satisfies [string, string][]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        requireNumber(context);
        const text = commentText(input.body, true);
        return { body: text, digest: { body: text } };
      },
    };
  }
  entries['/issues/update'] = {
    kind: 'issue-update',
    normalize: (input, context) => {
      requireNumber(context);
      const title = requestText(input.title);
      if (!title || title.length > TITLE_MAX) throw invalidMutationContext(`title is required and must fit ${TITLE_MAX} characters`);
      if (input.body !== undefined && !isString(input.body)) throw invalidMutationContext('body must be a string');
      const normalized: StandardMutationInput & { title: string } = { title };
      if (input.body !== undefined) normalized.body = input.body;
      normalized.digest = { title, body: normalized.body ?? null };
      return normalized;
    },
  };
  for (const [route, kind] of [
    ['/pr/comment/update', 'change-request-comment-update'],
    ['/issues/comment/update', 'issue-comment-update'],
  ] satisfies [string, string][]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        requireNumber(context);
        const id = commentId(input.commentId);
        const text = commentText(input.body, true);
        return { commentId: id, body: text, digest: { commentId: id, body: text } };
      },
    };
  }
  for (const [route, kind] of [
    ['/pr/comment/delete', 'change-request-comment-delete'],
    ['/issues/comment/delete', 'issue-comment-delete'],
  ] satisfies [string, string][]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        requireNumber(context);
        const id = commentId(input.commentId);
        return { commentId: id, digest: { commentId: id } };
      },
    };
  }
  if (reviewThreads.reply) {
    entries['/pr/thread/reply'] = {
      kind: 'change-request-thread-reply',
      normalize: (input, context) => {
        requireNumber(context);
        const id = threadIdOf(input.threadId);
        const text = commentText(input.body, true);
        return { threadId: id, body: text, digest: { threadId: id, body: text } };
      },
    };
  }
  if (reviewThreads.resolve) {
    entries['/pr/thread/resolve'] = {
      kind: 'change-request-thread-resolve',
      normalize: (input, context) => {
        requireNumber(context);
        const id = threadIdOf(input.threadId);
        if (input.resolved !== true && input.resolved !== false) throw invalidMutationContext('resolved is required');
        return { threadId: id, resolved: input.resolved, digest: { threadId: id, resolved: input.resolved } };
      },
    };
  }
  for (const [route, kind] of [['/pr/state', 'change-request-state'], ['/issues/state', 'issue-state']] satisfies [string, string][]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        if (!context.target.number || !includes(['open', 'closed'], input.state)) {
          throw invalidMutationContext('target number and state are required');
        }
        if (input.reason !== undefined) throw invalidMutationContext(`${descriptor.label} closes without a reason`);
        return { state: input.state, digest: { state: input.state } };
      },
    };
  }
  for (const [route, kind, field] of [
    ['/pr/labels', 'change-request-labels', 'labels'],
    ['/issues/labels', 'issue-labels', 'labels'],
    ['/pr/reviewers', 'change-request-reviewers', 'reviewers'],
  ] satisfies [string, string, string][]) {
    entries[route] = {
      kind,
      normalize: (input, context) => {
        requireNumber(context);
        const names = nameList(input[field], field === 'labels' ? descriptor.limits.labelsMax : descriptor.limits.reviewersMax);
        if (field === 'reviewers' && names.some((id) => !descriptor.limits.reviewerId.test(id))) {
          throw invalidMutationContext('reviewers are invalid');
        }
        return { names, digest: { [field]: names } };
      },
    };
  }

  if (descriptor.presentation.features.issueAssignees === true) {
    entries['/issues/assignees'] = {
      kind: 'issue-assignees',
      normalize: (input, context) => {
        requireNumber(context);
        const names = nameList(input.assignees, descriptor.limits.reviewersMax);
        return { names, digest: { assignees: names } };
      },
    };
  }

  const entryFor = (route: string) => {
    if (!Object.hasOwn(entries, route)) throw invalidMutationContext('Source control mutation is unsupported');
    const entry = entries[route];
    if (!entry) throw invalidMutationContext('Source control mutation is unsupported');
    return entry;
  };

  return Object.freeze({
    routes: Object.freeze(Object.keys(entries)),
    prepare: ({ route, input, context, actor, credential }: {
      route: string;
      input: SourceControlJsonObject;
      context: MutationContextInput;
      actor: AccountIdentity;
      credential: { accountId: string; credentialRevision: number };
    }) => {
      const entry = entryFor(route);
      const normalized = entry.normalize(input, context);
      return {
        kind: entry.kind,
        input: normalized,
        digest: (target: SourceControlMutationTarget) => digestMutationInput({ kind: entry.kind, actor, credential, target, ...normalized.digest }),
      };
    },
  });
}
