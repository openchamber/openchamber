import { describe, expect, it, vi } from 'vitest';
import { cancelWaitingMerge, enableMergeWhenReady } from './merge-when-ready.js';

const project = { owner: 'acme', name: 'app' };
const target = { number: 7, base: 'main', headSha: 'abc' };
const pull = (overrides = {}) => ({ id: 'PR_7', state: 'OPEN', headRefOid: 'abc', mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED', isInMergeQueue: false, autoMergeRequest: null, ...overrides });
const client = (pr = pull(), queue = null) => ({ graphql: vi.fn(async (query) => {
  if (query.startsWith('query')) return { repository: { pullRequest: pr, mergeQueue: queue } };
  if (query.includes('enablePullRequestAutoMerge')) return { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: '2026-11-03' } } } };
  if (query.includes('disablePullRequestAutoMerge')) return { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } };
  return { dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } };
}) });

describe('GitHub merge when ready', () => {
  it('enables auto-merge with the chosen method and an expected head guard', async () => {
    const octokit = client();
    expect(await enableMergeWhenReady(octokit, project, target, 'squash')).toEqual({ merged: false, outcome: 'auto-merge' });
    expect(octokit.graphql.mock.calls[1][1]).toEqual({ id: 'PR_7', mergeMethod: 'SQUASH', sha: 'abc' });
    expect(octokit.graphql.mock.calls[1][0]).toContain('expectedHeadOid: $sha');
  });
  it.each([
    [pull(), { id: 'MQ' }], [pull({ state: 'CLOSED' }), null], [pull({ headRefOid: 'moved' }), null],
    [pull({ mergeable: 'CONFLICTING' }), null], [pull({ mergeStateStatus: 'CLEAN' }), null],
  ])('does not auto-merge a queue, moved head, conflict or a settled pull', async (pr, queue) => {
    const octokit = client(pr, queue);
    expect(await enableMergeWhenReady(octokit, project, target, 'merge')).toBeNull();
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
  it('preserves a refusal when the state read fails', async () => {
    expect(await enableMergeWhenReady({ graphql: async () => { throw new Error('offline'); } }, project, target, 'merge')).toBeNull();
  });
  it('passes on a refused auto-merge without claiming it was enabled', async () => {
    const octokit = client();
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull(), mergeQueue: null } }))
      .mockImplementationOnce(async () => { throw new Error('Auto-merge is not allowed'); });
    await expect(enableMergeWhenReady(octokit, project, target, 'merge')).rejects.toThrow('Auto-merge is not allowed');
  });
  it('dequeues and disables any remaining auto-merge request', async () => {
    const octokit = client(pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }));
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }))
      .mockImplementationOnce(async () => ({ dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } }))
      .mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: false, outcome: 'cancelled' });
    expect(octokit.graphql.mock.calls[1][0]).toContain('dequeuePullRequest(input: { id: $id })');
    expect(octokit.graphql.mock.calls[3][0]).toContain('disablePullRequestAutoMerge');
  });
  it('does not disable again when dequeue already cleared auto-merge', async () => {
    const octokit = client();
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }))
      .mockImplementationOnce(async () => ({ dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: false, outcome: 'cancelled' });
    expect(octokit.graphql).toHaveBeenCalledTimes(3);
  });
  it('reports a merge that won the race with cancellation truthfully', async () => {
    const octokit = client(pull({ state: 'MERGED' }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: true });
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
});
