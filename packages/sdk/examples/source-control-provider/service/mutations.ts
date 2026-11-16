import type {
  SourceControlJson,
  SourceControlJsonObject,
  SourceControlMutationResult,
  SourceControlOutboundMethod,
  SourceControlReconcileData,
} from '@openchamber/sdk';

import type { Call, GiteaBranchRef, GiteaComment, GiteaIssue, GiteaPull, GiteaSubscriptionCheck, GiteaUser, ProviderTarget } from './types.ts';

type Input = SourceControlJsonObject;

type CallErrorClass = new (message: string, status: number, code?: string) => Error & { readonly status: number; readonly code: string | undefined };

export type MutationDeps = {
  api: <T>(call: Call, method: SourceControlOutboundMethod, path: string, options?: { query?: Record<string, string>; body?: SourceControlJsonObject }) => Promise<{ data: T; total: number | null }>;
  CallError: CallErrorClass;
  repoPath: (repo: { owner: string; name: string }) => string;
  seg: (value: string) => string;
  text: (input: Input, key: string) => string;
  integer: (input: Input, key: string) => number;
  objectOf: (input: Input, key: string) => Input;
  readPull: (call: Call, repo: { owner: string; name: string }, number: number) => Promise<GiteaPull>;
  branchRepoId: (ref: GiteaBranchRef) => number | undefined;
  scanSize: number;
  fileScanPages: number;
};

type Resolved = { providerTarget: ProviderTarget; target: Input };
type ReviewerCandidate = { id: string; login: string; avatarUrl?: string };

export const createMutations = ({
  api, CallError, repoPath, seg, text, integer, objectOf, readPull, branchRepoId, scanSize, fileScanPages,
}: MutationDeps) => {
  const stringsOf = (input: Input, key: string): string[] => {
    const value = input[key];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
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

  /**
   * A comment's address, once the forge says it sits on the resolved issue or
   * pull request. Comment ids are repository-wide on Gitea, so an id from
   * another item would otherwise be changed while this one is recorded.
   */
  const itemCommentPath = async (call: Call, providerTarget: ProviderTarget, commentId: string): Promise<string> => {
    const path = `${repoPath(providerTarget)}/issues/comments/${seg(commentId)}`;
    const { data } = await api<GiteaComment>(call, 'GET', path);
    const href = (data.issue_url || data.pull_request_url || '').toLowerCase();
    const item = `${call.identity.instance.replace(/\/+$/, '')}/${providerTarget.owner}/${providerTarget.name}`.toLowerCase();
    const match = href.startsWith(`${item}/`) ? /^\/(?:issues|pulls)\/(\d+)\/?$/.exec(href.slice(item.length)) : null;
    if (!match || Number(match[1]) !== providerTarget.number) {
      throw new CallError('The comment is not on this item', 409, 'SOURCE_CONTROL_MUTATION_TARGET_INVALID');
    }
    return path;
  };

  /** Every page of a user list (collaborators, assignable users); a list longer than the scan fails rather than answering part of it. */
  const readUsers = async (call: Call, path: string): Promise<GiteaUser[]> => {
    const users: GiteaUser[] = [];
    for (let page = 1; page <= fileScanPages; page += 1) {
      const { data, total } = await api<GiteaUser[]>(call, 'GET', path, { query: { page: String(page), limit: String(scanSize) } });
      users.push(...data);
      if (data.length < scanSize || (total !== null && users.length >= total)) return users;
    }
    throw new CallError(`The repository has more people than this Git host reads (${fileScanPages * scanSize})`, 502, 'SCAN_LIMIT');
  };

  /** The logins Gitea takes as `assignees`, from the ids (or logins) the board sent. */
  const assigneeLogins = async (call: Call, providerTarget: ProviderTarget, names: string[]): Promise<string[]> => {
    const repo = repoPath(providerTarget);
    const [issue, collaborators, assignable] = await Promise.all([
      api<GiteaIssue>(call, 'GET', `${repo}/issues/${providerTarget.number}`),
      readUsers(call, `${repo}/collaborators`),
      readUsers(call, `${repo}/assignees`),
    ]);
    const byId = new Map([...(issue.data.assignees ?? []), ...collaborators, ...assignable].map((user) => [String(user.id), user.login]));
    return names.map((entry) => {
      const login = byId.get(entry) ?? (/^\d+$/.test(entry) ? null : entry);
      if (!login) throw new CallError(`User ${entry} cannot be assigned in this repository`, 422);
      return login;
    });
  };

  const listReviewerCandidates = async (call: Call, input: Input): Promise<SourceControlJson> => {
    const selector = objectOf(input, 'project');
    const owner = text(selector, 'owner');
    const name = text(selector, 'name') || text(selector, 'repo');
    if (!owner || !name) throw new CallError('project is required', 400);
    const kind = text(input, 'role') === 'assignee' ? 'assignees' : 'collaborators';
    const users = await readUsers(call, `${repoPath({ owner, name })}/${kind}`);
    const byId = new Map(users.map((user): [string, GiteaUser] => [String(user.id), user]));
    return [...byId.values()].map((user) => {
      const candidate: ReviewerCandidate = { id: String(user.id), login: user.login };
      if (user.avatar_url) candidate.avatarUrl = user.avatar_url;
      return candidate;
    });
  };

  const currentLogin = async (call: Call): Promise<string> => {
    const known = call.session.user?.login;
    if (known) return known;
    const { data } = await api<GiteaUser>(call, 'GET', '/user');
    return data.login;
  };

  const perform = async (call: Call, input: Input): Promise<SourceControlMutationResult> => {
    const kind = text(input, 'kind');
    const normalized = objectOf(input, 'input');
    const { providerTarget, target } = readResolved(input);
    const repo = repoPath(providerTarget);
    switch (kind) {
      case 'change-request-create': {
        // A branch of a fork is named `owner:branch`; Gitea would read a bare name as the target's own branch.
        const sourceRepoId = providerTarget.sourceRepoId ?? providerTarget.repoId;
        const fork = sourceRepoId !== providerTarget.repoId;
        const head = text(target, 'head');
        const payload: SourceControlJsonObject = {
          head: fork ? `${providerTarget.sourceOwner}:${head}` : head, base: text(target, 'base'), title: text(normalized, 'title'),
        };
        const body = text(normalized, 'body');
        if (body) payload.body = body;
        const { data } = await api<GiteaPull>(call, 'POST', `${repo}/pulls`, { body: payload });
        if (branchRepoId(data.base) !== providerTarget.repoId || branchRepoId(data.head) !== sourceRepoId) {
          throw new CallError('The forge opened the pull request somewhere other than asked', 502);
        }
        return { number: data.number };
      }
      case 'change-request-update': {
        const payload: SourceControlJsonObject = { title: text(normalized, 'title') };
        if (Object.hasOwn(normalized, 'body')) payload.body = text(normalized, 'body');
        await api(call, 'PATCH', `${repo}/pulls/${providerTarget.number}`, { body: payload });
        return {};
      }
      case 'change-request-base': {
        const base = text(normalized, 'base');
        const { data } = await api<GiteaPull>(call, 'PATCH', `${repo}/pulls/${providerTarget.number}`, { body: { base } });
        if (data.base.ref !== base || branchRepoId(data.base) !== providerTarget.repoId) {
          throw new CallError('The forge answered a pull request with a different base', 502);
        }
        return {};
      }
      case 'change-request-update-branch': {
        const expectedHeadSha = text(normalized, 'expectedHeadSha');
        const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
        if (pull.head.sha.toLowerCase() !== expectedHeadSha) {
          throw new CallError('The pull request head changed', 409, 'SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        }
        await api(call, 'POST', `${repo}/pulls/${providerTarget.number}/update`, { query: { style: 'merge' } });
        return {};
      }
      case 'issue-update': {
        const payload: SourceControlJsonObject = { title: text(normalized, 'title') };
        if (Object.hasOwn(normalized, 'body')) payload.body = text(normalized, 'body');
        await api(call, 'PATCH', `${repo}/issues/${providerTarget.number}`, { body: payload });
        return {};
      }
      case 'issue-assignees': {
        const logins = await assigneeLogins(call, providerTarget, stringsOf(normalized, 'names'));
        const { data } = await api<GiteaIssue>(call, 'PATCH', `${repo}/issues/${providerTarget.number}`, { body: { assignees: logins } });
        const answered = (data.assignees ?? []).map((user) => user.login);
        if (answered.length !== logins.length || !answered.every((login) => logins.includes(login))) {
          throw new CallError('The forge answered an unexpected assignee set', 502);
        }
        return {};
      }
      case 'issue-subscription':
      case 'change-request-subscription': {
        const login = await currentLogin(call);
        const path = `${repo}/issues/${providerTarget.number}/subscriptions/${seg(login)}`;
        if (normalized.subscribed === true) await api(call, 'PUT', path);
        else await api(call, 'DELETE', path);
        return {};
      }
      case 'change-request-merge': {
        // `head_commit_id` makes the forge refuse once the branch moved past the head the user saw.
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
        const { data } = await api<GiteaIssue>(call, 'PATCH', `${repo}/issues/${providerTarget.number}`, { body: { state } });
        if (data.state !== state) throw new CallError('The forge did not change the state', 502);
        return { state };
      }
      default:
        throw new CallError(`${kind} is not something this Git host offers`, 501, 'UNSUPPORTED');
    }
  };

  const NOT_APPLIED: SourceControlReconcileData = { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };

  /** After a restart: did the write OpenChamber recorded as running land? Only a certain answer is `succeeded` or `failed`. */
  const reconcile = async (call: Call, input: Input): Promise<SourceControlReconcileData> => {
    const kind = text(input, 'kind');
    const normalized = objectOf(input, 'input');
    const { providerTarget, target } = readResolved(input);
    const repo = repoPath(providerTarget);
    switch (kind) {
      case 'change-request-create': {
        const sourceRepoId = providerTarget.sourceRepoId ?? providerTarget.repoId;
        const { data } = await api<GiteaPull[]>(call, 'GET', `${repo}/pulls`, { query: { state: 'all', sort: 'recentupdate', limit: String(scanSize) } });
        const matches = data.filter((pull) => pull.head.ref === text(target, 'head') && pull.base.ref === text(target, 'base')
          && branchRepoId(pull.head) === sourceRepoId && branchRepoId(pull.base) === providerTarget.repoId);
        return matches.length === 1 ? { state: 'succeeded', result: { number: matches[0].number } } : { state: 'outcome-unknown' };
      }
      case 'change-request-update': {
        // The forge shows the edit, or it shows something else: an edit of its own since, or the write never landed.
        const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
        const landed = pull.title === text(normalized, 'title') && (!Object.hasOwn(normalized, 'body') || (pull.body ?? '') === text(normalized, 'body'));
        return landed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
      }
      case 'change-request-base': {
        const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
        return pull.base.ref === text(normalized, 'base') ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
      }
      case 'change-request-update-branch': {
        const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
        return pull.head.sha.toLowerCase() !== text(normalized, 'expectedHeadSha') ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
      }
      case 'issue-update': {
        const { data } = await api<GiteaIssue>(call, 'GET', `${repo}/issues/${providerTarget.number}`);
        const landed = data.title === text(normalized, 'title')
          && (!Object.hasOwn(normalized, 'body') || (data.body ?? '') === text(normalized, 'body'));
        return landed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
      }
      case 'issue-assignees': {
        const logins = await assigneeLogins(call, providerTarget, stringsOf(normalized, 'names'));
        const { data } = await api<GiteaIssue>(call, 'GET', `${repo}/issues/${providerTarget.number}`);
        const current = (data.assignees ?? []).map((user) => user.login);
        return current.length === logins.length && current.every((login) => logins.includes(login))
          ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
      }
      case 'issue-subscription':
      case 'change-request-subscription': {
        const { data } = await api<GiteaSubscriptionCheck>(call, 'GET', `${repo}/issues/${providerTarget.number}/subscriptions/check`);
        return data.subscribed === (normalized.subscribed === true) ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
      }
      case 'change-request-merge': {
        const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
        return pull.merged ? { state: 'succeeded', result: { merged: true } } : NOT_APPLIED;
      }
      case 'change-request-state':
      case 'issue-state': {
        const { data } = await api<GiteaIssue>(call, 'GET', `${repo}/issues/${providerTarget.number}`);
        return data.state === text(normalized, 'state') ? { state: 'succeeded', result: { state: data.state } } : NOT_APPLIED;
      }
      // A comment leaves nothing that tells a lost write from one never sent.
      default:
        return { state: 'outcome-unknown' };
    }
  };

  return { perform, reconcile, listReviewerCandidates };
};

export type Mutations = ReturnType<typeof createMutations>;
