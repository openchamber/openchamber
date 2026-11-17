import type {
  SourceControlJson,
  SourceControlJsonObject,
  SourceControlMutationResult,
  SourceControlMutationTarget,
  SourceControlOutboundMethod,
  SourceControlReconcileData,
} from '@openchamber/sdk';
import type { ReviewCall, ReviewDraftsDeps, Reviews } from './review-drafts.ts';

const reviewsPath = `./review-drafts${'.js'}`;
const { createReviewDrafts }: { createReviewDrafts: (deps: ReviewDraftsDeps) => Reviews } = await import(reviewsPath);

type MutationRepo = {
  id: number;
  owner: { login: string };
  name: string;
  html_url: string;
  clone_url?: string;
  default_branch?: string;
  fork?: boolean;
  parent?: MutationRepo | null;
};

type MutationBranchRef = { ref: string; sha: string; repo_id?: number; repo?: MutationRepo };

type MutationPull = {
  number: number;
  title: string;
  body?: string | null;
  user?: { login: string };
  merged?: boolean;
  head: MutationBranchRef;
  base: MutationBranchRef;
};

type MutationProject = {
  provider: string;
  instance: string;
  id: string;
  owner: string;
  name: string;
  url: string;
  cloneUrl?: string;
  defaultBranch?: string;
  remoteName?: string | null;
};

type Input = SourceControlJsonObject;

export type MutationDeps = {
  api: <T>(
    call: ReviewCall,
    method: SourceControlOutboundMethod,
    path: string,
    options?: { query?: Record<string, string>; body?: SourceControlJsonObject },
  ) => Promise<{ data: T }>;
  repoPath: (repo: { owner: string; name: string }) => string;
  text: (input: Input, key: string) => string;
  integer: (input: Input, key: string) => number;
  objectOf: (input: Input, key: string) => Input;
  selectorOf: (input: Input, key: string) => { owner: string; name: string } | undefined;
  resolveRepo: (
    call: ReviewCall,
    directory: string,
    remote: string,
    project?: { owner: string; name: string },
  ) => Promise<{ raw: MutationRepo; project: MutationProject }>;
  readPull: (call: ReviewCall, repo: { owner: string; name: string }, number: number) => Promise<MutationPull>;
  compact: (project: MutationProject) => { id: string; owner: string; name: string };
  branchRepoId: (ref: MutationBranchRef) => number | undefined;
  fail: (message: string, status: number, code?: string) => Error;
};

type ProviderTarget = { repoId: number; owner: string; name: string; number?: number; sourceRepoId?: number; sourceOwner?: string };
type Resolved = { providerTarget: ProviderTarget; target: Input };

const TARGET_KEYS = ['number', 'head', 'base', 'headSha'] as const;

const REVIEW_KINDS = new Set([
  'change-request-review-comment',
  'change-request-review-comment-update',
  'change-request-review-comment-delete',
  'change-request-review-discard',
  'change-request-review-dismiss',
]);

export const createMutations = (deps: MutationDeps) => {
  const { api, repoPath, text, integer, objectOf, selectorOf, resolveRepo, readPull, compact, branchRepoId, fail } = deps;
  const review = createReviewDrafts({ api, repoPath, text, integer, objectOf, selectorOf, resolveRepo, readPull, fail });

  const mutationTarget = (context: Input, project: MutationProject, fields: Partial<SourceControlMutationTarget>): SourceControlMutationTarget => {
    const target: SourceControlMutationTarget = {
      repositoryId: text(context, 'repositoryId'),
      bindingRevision: integer(context, 'bindingRevision'),
      primaryRemote: text(context, 'primaryRemote'),
      project: compact(project),
    };
    for (const key of TARGET_KEYS) {
      const value = fields[key];
      if (value === undefined) continue;
      if (key === 'number') target.number = Number(value);
      else target[key] = String(value);
    }
    return target;
  };

  const asJson = (resolution: { providerTarget: ProviderTarget; target: SourceControlMutationTarget }): SourceControlJsonObject => ({
    providerTarget: resolution.providerTarget,
    target: { ...resolution.target, project: { ...resolution.target.project } },
  });

  const resolveHeadSource = async (call: ReviewCall, directory: string, primaryRemote: string, target: MutationRepo, normalized: Input): Promise<MutationRepo> => {
    const remote = text(normalized, 'remote');
    if (remote && remote !== primaryRemote) {
      throw fail(`Pull requests open on the bound remote "${primaryRemote}", not "${remote}"`, 409, 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH');
    }
    const headRemote = text(normalized, 'headRemote');
    if (!headRemote || headRemote === primaryRemote) return target;
    const { raw: head } = await resolveRepo(call, directory, headRemote);
    if (head.id !== target.id && head.parent?.id !== target.id) {
      throw fail(
        `The remote "${headRemote}" is neither ${target.owner.login}/${target.name} nor a fork of it on this forge`,
        409,
        'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH',
      );
    }
    return head;
  };

  const resolveTarget = async (call: ReviewCall, input: Input): Promise<SourceControlJson> => {
    const context = objectOf(input, 'context');
    const expected = objectOf(context, 'target');
    const kind = text(input, 'kind');
    const replayOf = objectOf(input, 'replayOf');
    const primaryRemote = text(context, 'primaryRemote');
    const { raw, project } = await resolveRepo(call, text(context, 'directory'), primaryRemote);
    const providerTarget: ProviderTarget = { repoId: raw.id, owner: project.owner, name: project.name };
    if (kind === 'change-request-create') {
      const source = await resolveHeadSource(call, text(context, 'directory'), primaryRemote, raw, objectOf(input, 'input'));
      return asJson({
        providerTarget: { ...providerTarget, sourceRepoId: source.id, sourceOwner: source.owner.login },
        target: mutationTarget(context, project, { head: text(expected, 'head'), base: text(expected, 'base') }),
      });
    }
    const replayTarget = objectOf(replayOf, 'target');
    const number = integer(replayTarget, 'number') || integer(expected, 'number');
    if (!number) throw fail('target number is required', 400, 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT');
    if (Object.keys(replayTarget).length > 0) {
      return { providerTarget: { ...providerTarget, number }, target: replayTarget };
    }
    if (kind.startsWith('issue-')) {
      const { data } = await api<{ number: number }>(call, 'GET', `${repoPath(project)}/issues/${number}`);
      return asJson({ providerTarget: { ...providerTarget, number }, target: mutationTarget(context, project, { number: data.number }) });
    }
    const pull = await readPull(call, project, number);
    for (const [key, actual] of [['head', pull.head.ref], ['base', pull.base.ref], ['headSha', pull.head.sha]] as const) {
      const wanted = text(expected, key);
      if (wanted && wanted !== actual) throw fail(`The pull request ${key} changed`, 409, 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH');
    }
    return asJson({
      providerTarget: { ...providerTarget, number },
      target: mutationTarget(context, project, { number, head: pull.head.ref, base: pull.base.ref, headSha: pull.head.sha }),
    });
  };

  const readResolved = (input: Input): Resolved => {
    const resolved = objectOf(input, 'resolved');
    const providerTarget = objectOf(resolved, 'providerTarget');
    return {
      providerTarget: {
        repoId: integer(providerTarget, 'repoId'),
        owner: text(providerTarget, 'owner'),
        name: text(providerTarget, 'name'),
        number: integer(providerTarget, 'number') || undefined,
        sourceRepoId: integer(providerTarget, 'sourceRepoId') || undefined,
        sourceOwner: text(providerTarget, 'sourceOwner') || undefined,
      },
      target: objectOf(resolved, 'target'),
    };
  };

  const itemCommentPath = async (call: ReviewCall, providerTarget: ProviderTarget, commentId: string): Promise<string> => {
    const path = `${repoPath(providerTarget)}/issues/comments/${encodeURIComponent(commentId)}`;
    const { data } = await api<{ issue_url?: string; pull_request_url?: string }>(call, 'GET', path);
    const href = (data.issue_url || data.pull_request_url || '').toLowerCase();
    const item = `${call.identity.instance.replace(/\/+$/, '')}/${providerTarget.owner}/${providerTarget.name}`.toLowerCase();
    const match = href.startsWith(`${item}/`) ? /^\/(?:issues|pulls)\/(\d+)\/?$/.exec(href.slice(item.length)) : null;
    if (!match || Number(match[1]) !== providerTarget.number) {
      throw fail('The comment is not on this item', 409, 'SOURCE_CONTROL_MUTATION_TARGET_INVALID');
    }
    return path;
  };

  const perform = async (call: ReviewCall, input: Input): Promise<SourceControlMutationResult> => {
    const kind = text(input, 'kind');
    const normalized = objectOf(input, 'input');
    const { providerTarget, target } = readResolved(input);
    const repo = repoPath(providerTarget);
    if (REVIEW_KINDS.has(kind)) return review.perform(call, kind, normalized, providerTarget);
    switch (kind) {
      case 'change-request-create': {
        const sourceRepoId = providerTarget.sourceRepoId ?? providerTarget.repoId;
        const fork = sourceRepoId !== providerTarget.repoId;
        const head = text(target, 'head');
        const payload: SourceControlJsonObject = {
          head: fork ? `${providerTarget.sourceOwner}:${head}` : head, base: text(target, 'base'), title: text(normalized, 'title'),
        };
        const body = text(normalized, 'body');
        if (body) payload.body = body;
        const { data } = await api<{ number: number; head: MutationBranchRef; base: MutationBranchRef }>(call, 'POST', `${repo}/pulls`, { body: payload });
        if (branchRepoId(data.base) !== providerTarget.repoId || branchRepoId(data.head) !== sourceRepoId) {
          throw fail('The forge opened the pull request somewhere other than asked', 502);
        }
        return { number: data.number };
      }
      case 'change-request-update': {
        const payload: SourceControlJsonObject = { title: text(normalized, 'title') };
        if (Object.hasOwn(normalized, 'body')) payload.body = text(normalized, 'body');
        await api(call, 'PATCH', `${repo}/pulls/${providerTarget.number}`, { body: payload });
        return {};
      }
      case 'issue-update': {
        const payload: SourceControlJsonObject = { title: text(normalized, 'title') };
        if (Object.hasOwn(normalized, 'body')) payload.body = text(normalized, 'body');
        await api(call, 'PATCH', `${repo}/issues/${providerTarget.number}`, { body: payload });
        return {};
      }
      case 'change-request-merge': {
        const payload: SourceControlJsonObject = { Do: text(normalized, 'method') || 'merge' };
        const headSha = text(target, 'headSha');
        if (headSha) payload.head_commit_id = headSha;
        await api(call, 'POST', `${repo}/pulls/${providerTarget.number}/merge`, { body: payload });
        const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
        return { merged: pull.merged === true };
      }
      case 'change-request-comment':
      case 'issue-comment':
        await api(call, 'POST', `${repo}/issues/${providerTarget.number}/comments`, { body: { body: text(normalized, 'body') } });
        return {};
      case 'change-request-comment-update':
      case 'issue-comment-update':
        await api(call, 'PATCH', await itemCommentPath(call, providerTarget, text(normalized, 'commentId')), { body: { body: text(normalized, 'body') } });
        return {};
      case 'change-request-comment-delete':
      case 'issue-comment-delete':
        await api(call, 'DELETE', await itemCommentPath(call, providerTarget, text(normalized, 'commentId')));
        return {};
      case 'change-request-state':
      case 'issue-state': {
        const state = text(normalized, 'state');
        const { data } = await api<{ state: string }>(call, 'PATCH', `${repo}/issues/${providerTarget.number}`, { body: { state } });
        if (data.state !== state) throw fail('The forge did not change the state', 502);
        return { state };
      }
      default:
        throw fail(`${kind} is not something this Git host offers`, 501, 'UNSUPPORTED');
    }
  };

  const NOT_APPLIED: SourceControlReconcileData = { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };

  const reconcile = async (call: ReviewCall, input: Input): Promise<SourceControlReconcileData> => {
    const kind = text(input, 'kind');
    const normalized = objectOf(input, 'input');
    const { providerTarget, target } = readResolved(input);
    const repo = repoPath(providerTarget);
    if (REVIEW_KINDS.has(kind)) return review.reconcile(call, kind, normalized, providerTarget);
    switch (kind) {
      case 'change-request-create': {
        const sourceRepoId = providerTarget.sourceRepoId ?? providerTarget.repoId;
        const { data } = await api<Array<{ number: number; head: MutationBranchRef; base: MutationBranchRef }>>(
          call,
          'GET',
          `${repo}/pulls`,
          { query: { state: 'all', sort: 'recentupdate', limit: '50' } },
        );
        const matches = data.filter((pull) => pull.head.ref === text(target, 'head') && pull.base.ref === text(target, 'base')
          && branchRepoId(pull.head) === sourceRepoId && branchRepoId(pull.base) === providerTarget.repoId);
        return matches.length === 1 ? { state: 'succeeded', result: { number: matches[0].number } } : { state: 'outcome-unknown' };
      }
      case 'change-request-update': {
        const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
        const landed = pull.title === text(normalized, 'title') && (!Object.hasOwn(normalized, 'body') || (pull.body ?? '') === text(normalized, 'body'));
        return landed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
      }
      case 'issue-update': {
        const { data } = await api<{ title: string; body?: string | null }>(call, 'GET', `${repo}/issues/${providerTarget.number}`);
        const landed = data.title === text(normalized, 'title')
          && (!Object.hasOwn(normalized, 'body') || (data.body ?? '') === text(normalized, 'body'));
        return landed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
      }
      case 'change-request-merge': {
        const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
        return pull.merged ? { state: 'succeeded', result: { merged: true } } : NOT_APPLIED;
      }
      case 'change-request-state':
      case 'issue-state': {
        const { data } = await api<{ state: string }>(call, 'GET', `${repo}/issues/${providerTarget.number}`);
        return data.state === text(normalized, 'state') ? { state: 'succeeded', result: { state: data.state } } : NOT_APPLIED;
      }
      default:
        return { state: 'outcome-unknown' };
    }
  };

  return { reviewState: review.reviewState, resolveTarget, perform, reconcile };
};

export type Mutations = ReturnType<typeof createMutations>;
