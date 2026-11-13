import { describe, expect, it, vi } from 'vitest';
import { createGitHubMutations } from './mutations.js';

const project = { owner: 'acme', name: 'app' };
const repository = { owner: { login: 'acme' }, name: 'app', html_url: 'https://github.com/acme/app' };
const pull = {
  number: 7, title: 'Upper layer', html_url: 'https://github.com/acme/app/pull/7',
  state: 'open', draft: false, merged: false, user: { id: 1, login: 'author' },
  head: { ref: 'upper', sha: 'abc123', repo: repository },
  base: { ref: 'lower', repo: repository },
};
const context = {
  provider: 'github', instance: 'github.com', accountId: 'account', directory: '/repo',
  repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin', idempotencyKey: 'cancel-one',
  target: { project, number: pull.number, head: pull.head.ref, base: pull.base.ref, headSha: pull.head.sha },
};

const fixture = () => {
  let queued = true;
  let autoMerge = { enabledAt: '2026-11-04T00:00:00Z', mergeMethod: 'SQUASH' };
  const graphql = vi.fn(async (query) => {
    if (query.includes('dequeuePullRequest(input:')) {
      queued = false;
      return { dequeuePullRequest: { mergeQueueEntry: null } };
    }
    if (query.includes('disablePullRequestAutoMerge(input:')) {
      autoMerge = null;
      return { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } };
    }
    return { repository: { mergeQueue: { id: 'queue' }, pullRequest: {
      id: 'pull-7', state: 'OPEN', headRefOid: pull.head.sha, mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED', isInMergeQueue: queued, autoMergeRequest: autoMerge,
    } } };
  });
  const list = vi.fn(async () => ({ data: [{ ...pull, number: 6, head: { ...pull.head, ref: 'lower' } }] }));
  const request = vi.fn(async () => ({ data: [] }));
  const octokit = { openChamberHost: 'github.com', graphql, request, rest: { pulls: {
    get: vi.fn(async () => ({ data: pull })), list,
  } } };
  const mutations = createGitHubMutations({
    descriptor: { limits: {} }, octokitOf: () => octokit,
    resolveRepo: async () => ({ repo: { owner: 'acme', repo: 'app' } }),
    resolveNetwork: async () => null,
  });
  return { mutations, graphql, list, request };
};

describe('stack merge cancellation admission', () => {
  it('keeps inferred upper-layer merges blocked', async () => {
    const { mutations, list, request } = fixture();
    await expect(mutations.resolveTarget({ session: {}, context, kind: 'change-request-merge', input: { method: 'squash' } }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_STACK_ORDER' });
    expect(list).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('cancels an upper-layer queue and retained auto-merge without reading stack membership', async () => {
    const { mutations, graphql, list, request } = fixture();
    const prepared = mutations.prepare({ route: '/pr/merge', input: { method: 'squash', cancel: true }, context,
      actor: { provider: 'github', instance: 'github.com', accountId: 'account' }, credential: { accountId: 'account', credentialRevision: 1 } });
    const resolved = await mutations.resolveTarget({ session: {}, context, ...prepared });
    await expect(mutations.perform({ session: {}, ...prepared, resolved })).resolves.toEqual({ merged: false, outcome: 'cancelled' });
    expect(graphql.mock.calls.filter(([query]) => query.startsWith('mutation')).map(([query]) => query.match(/(dequeuePullRequest|disablePullRequestAutoMerge)\(input:/)[1]))
      .toEqual(['dequeuePullRequest', 'disablePullRequestAutoMerge']);
    expect(list).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
