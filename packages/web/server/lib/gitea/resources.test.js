import { describe, expect, it } from 'vitest';
import { createGiteaClient } from './client.js';
import { createGiteaResourceService } from './resources.js';
import {
  fakeGitea, fixtures, forkNetworkRoutes, HEAD, MERGE_BASE, ORIGIN, replay, resolveForkRemote,
} from './fixtures/fake-fetch.js';

const pullsPage = (items, more = false) => new Response(JSON.stringify(items), {
  headers: more ? { link: '<next>; rel="next"' } : {},
});
const context = { repositoryId: 'repo-1', bindingRevision: 2, primaryRemote: 'origin', directory: '/repo' };
const upstream = { owner: 'alice', name: 'app' };
const providerTarget = { repoId: 1, owner: 'alice', name: 'app', number: 1 };
const closedPull = (number, extra = {}) => ({ ...fixtures.forkPull, number, state: 'closed', ...extra });

function setup(extra = {}) {
  // The fork itself has no pull requests of its own.
  const gitea = fakeGitea(forkNetworkRoutes({ 'GET /repos/bob/app/pulls': () => pullsPage([]), ...extra }));
  const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch: gitea.fetch, delay: async () => {} });
  return { ...gitea, service: createGiteaResourceService({ origin: ORIGIN, client, resolveRepos: resolveForkRemote }) };
}

describe('Gitea change request status', () => {
  it('finds a fork pull request in the upstream by base and head', async () => {
    const { service, calls } = setup({ 'GET /repos/alice/app/pulls/main/bob:feature': fixtures.forkPull });

    const status = await service.changeRequestStatus('/repo', 'feature', 'origin');

    expect(status).toMatchObject({
      project: { id: '1', owner: 'alice', name: 'app' },
      changeRequest: { number: 1, state: 'open', head: 'feature', headSha: HEAD },
      ci: { summary: { state: 'pending', total: 2 } },
      canMerge: true,
      resolvedRemoteName: 'origin',
    });
    expect(calls.some((call) => call.url.pathname === '/api/v1/repos/alice/app/pulls')).toBe(false);
  });

  it('looks a branch with a slash up directly, the slash encoded inside its segment', async () => {
    const slashed = { ...fixtures.forkPull, head: { ...fixtures.forkPull.head, ref: 'fix/thing', label: 'fix/thing' } };
    const { service, calls } = setup({ 'GET /repos/alice/app/pulls/main/bob:fix%2Fthing': slashed });

    await expect(service.changeRequestStatus('/repo', 'fix/thing', 'origin')).resolves.toMatchObject({ changeRequest: { head: 'fix/thing' } });
    expect(calls.some((call) => call.url.pathname === '/api/v1/repos/alice/app/pulls')).toBe(false);
  });

  it('falls back to scanning open pull requests where the direct route is missing (1.21)', async () => {
    const { service } = setup({
      'GET /repos/alice/app/pulls/main/bob:feature': () => replay(fixtures.errors.baseHeadRoute_1_21),
      'GET /repos/alice/app/pulls': (call) => {
        if (call.url.searchParams.get('state') !== 'open') return pullsPage([]);
        return call.url.searchParams.get('page') === '1'
          ? pullsPage([{ ...fixtures.forkPull_1_21, number: 4, head: { ...fixtures.forkPull_1_21.head, ref: 'other' } }], true)
          : pullsPage([fixtures.forkPull_1_21]);
      },
    });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).resolves.toMatchObject({ changeRequest: { number: 1 } });
  });

  it('answers no pull request only after a complete scan', async () => {
    const { service } = setup({
      'GET /repos/alice/app/pulls/main/bob:feature': () => replay(fixtures.errors.baseHeadNotFound),
      'GET /repos/alice/app/pulls': () => pullsPage([]),
    });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).resolves.toMatchObject({
      changeRequest: null, project: { id: '2', owner: 'bob' },
    });
  });

  it('answers the newest closed pull request as history, not the one the direct lookup returns', async () => {
    // Gitea answered the oldest pull request of a base and head pair, closed,
    // while a newer one from the same branch existed.
    const { service } = setup({
      'GET /repos/alice/app/pulls/main/bob:feature': closedPull(4),
      'GET /repos/alice/app/pulls': (call) => pullsPage(call.url.searchParams.get('state') === 'closed'
        ? [closedPull(11, { merged: true }), closedPull(9, { head: { ...fixtures.forkPull.head, ref: 'other' } })]
        : []),
    });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).resolves.toMatchObject({
      changeRequest: { number: 11, state: 'merged' },
    });
  });

  it('fails rather than answer "no pull request" when the scan hits its bound', async () => {
    const { service } = setup({
      'GET /repos/alice/app/pulls': () => pullsPage([{ ...fixtures.forkPull, head: { ...fixtures.forkPull.head, ref: 'other' } }], true),
    });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).rejects.toThrow('more open pull requests');
  });

  it('propagates a failed lookup instead of an empty status', async () => {
    const { service } = setup({ 'GET /repos/bob/app/pulls': () => new Response('{}', { status: 500 }) });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).rejects.toMatchObject({ status: 500 });
  });
});

describe('Gitea change request context', () => {
  const contextRoutes = (extra = {}) => ({
    'GET /repos/alice/app/pulls/1.diff': fixtures.forkPullDiff,
    'GET /repos/alice/app/pulls/1/files': fixtures.forkPullFiles,
    'GET /repos/alice/app/issues/1/comments': fixtures.comments,
    'GET /repos/alice/app/pulls/1/reviews': fixtures.reviews,
    [`GET /repos/alice/app/pulls/1/reviews/${fixtures.reviews[1].id}/comments`]: fixtures.reviewComments,
    'GET /repos/alice/app/pulls/1/commits': fixtures.commits,
    ...extra,
  });

  it('reads the diff per file, comments, reviews, commits and verdicts', async () => {
    const { service, calls } = setup(contextRoutes());

    const result = await service.changeRequestContext('/repo', 1, { includeDiff: true, includeTimeline: true, remote: 'origin' });

    expect(result.changeRequest).toMatchObject({ number: 1, headLabel: 'bob:feature', headProject: { id: '2', owner: 'bob' } });
    expect(result.files.map((file) => [file.path, file.status, Boolean(file.patch)])).toEqual([['feature.js', 'added', true]]);
    expect(result.issueComments.map((comment) => comment.body)).toEqual(['Looks good', 'First!']);
    expect(result.reviewComments).toEqual([expect.objectContaining({ path: 'feature.js', line: 1, body: 'Nit' })]);
    // Gitea pages commits newest first; the timeline reads oldest first.
    expect(fixtures.commits.map((commit) => commit.commit.message.split('\n')[0])).toEqual(['Finish feature', 'Start feature']);
    expect(result.commits.map((commit) => commit.headline)).toEqual(['Start feature', 'Finish feature']);
    expect(result.commitsComplete).toBe(true);
    expect(result.verdicts).toEqual([expect.objectContaining({ state: 'approved', author: expect.objectContaining({ username: 'alice' }) })]);
    expect(result.reviewers.map((user) => [user.id, user.username])).toEqual([['1', 'alice'], ['3', 'carol']]);
    // Comments are one list: Gitea ignores paging there.
    const commentReads = calls.filter((call) => call.url.pathname === '/api/v1/repos/alice/app/issues/1/comments');
    expect(commentReads).toHaveLength(1);
    expect(commentReads[0].url.searchParams.has('page')).toBe(false);
  });

  it('reports whether this account follows the pull request, through its issue', async () => {
    const checkPath = 'GET /repos/alice/app/issues/1/subscriptions/check';
    const { service } = setup(contextRoutes({ [checkPath]: { subscribed: true } }));

    await expect(service.changeRequestContext('/repo', 1, { remote: 'origin' })).resolves.toMatchObject({ subscribed: true });

    const { service: silent } = setup(contextRoutes());
    await expect(silent.changeRequestContext('/repo', 1, { remote: 'origin' })).resolves.not.toHaveProperty('subscribed');
  });

  it('keeps commits made within one second in the order Gitea lists them', async () => {
    const sameSecond = fixtures.commits.map((commit) => ({
      ...commit, commit: { ...commit.commit, committer: { ...commit.commit.committer, date: '2026-10-22T17:40:14+03:00' } },
    }));
    const { service } = setup(contextRoutes({ 'GET /repos/alice/app/pulls/1/commits': sameSecond }));

    const result = await service.changeRequestContext('/repo', 1, { includeTimeline: true, remote: 'origin' });

    expect(result.commits.map((commit) => commit.headline)).toEqual(['Start feature', 'Finish feature']);
  });

  it('reads more than a page of comments once, without repeating them', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ ...fixtures.comments[0], id: 100 + index, body: `Comment ${index}` }));
    const { service, calls } = setup({
      'GET /repos/alice/app/issues/6': fixtures.issue,
      // What Gitea does: every page answers the whole list.
      'GET /repos/alice/app/issues/6/comments': () => new Response(JSON.stringify(many), { headers: { 'x-total-count': '60' } }),
    });

    const comments = await service.issueComments('/repo', 6, upstream, 'origin');

    expect(comments).toHaveLength(60);
    expect(calls.filter((call) => call.url.pathname.endsWith('/issues/6/comments'))).toHaveLength(1);
  });

  it('reads both sides of a file at the merge base and the fork head, from the upstream', async () => {
    const { service, calls } = setup({
      'GET /repos/alice/app/raw/feature.js': (call) => (call.url.searchParams.get('ref') === HEAD ? 'export const feature = 2;\n' : 'old'),
    });

    await expect(service.changeRequestFileContents('/repo', 1, { remote: 'origin', path: 'feature.js', status: 'M' }))
      .resolves.toEqual({ original: 'old', modified: 'export const feature = 2;\n' });
    expect(calls.filter((call) => call.url.pathname.includes('/raw/')).map((call) => call.url.searchParams.get('ref')).sort())
      .toEqual([MERGE_BASE, HEAD].sort());
  });
});

describe("Gitea fork pull requests through the maintainer's upstream clone", () => {
  // Alice's clone of alice/app: the network is alice/app alone, and bob's
  // fork, where #1's head lives, is not in it.
  const resolveUpstreamRemote = async () => ({ repos: [{ owner: 'alice', name: 'app', repoPath: 'alice/app', url: `${ORIGIN}/alice/app`, remoteName: 'origin' }] });
  const setupUpstream = (extra = {}) => {
    const gitea = fakeGitea(forkNetworkRoutes(extra));
    const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch: gitea.fetch, delay: async () => {} });
    return { ...gitea, service: createGiteaResourceService({ origin: ORIGIN, client, resolveRepos: resolveUpstreamRemote }) };
  };

  it('reads an issue a link named in another repository, and refuses it without the link', async () => {
    const { service } = setupUpstream({
      'GET /repos/bob/app/issues/6': fixtures.issue,
    });
    const selector = { owner: 'bob', name: 'app' };
    await expect(service.getIssue('/repo', 6, selector, 'origin')).rejects.toMatchObject({ status: 404 });
    await expect(service.getIssue('/repo', 6, selector, 'origin', { linked: true })).resolves.toMatchObject({ number: fixtures.issue.number });
  });

  it("reads the patch, both sides of a file at the fork's head and the context from the upstream", async () => {
    const { service, calls } = setupUpstream({
      'GET /repos/alice/app/pulls/1.diff': fixtures.forkPullDiff,
      'GET /repos/alice/app/pulls/1/files': fixtures.forkPullFiles,
      'GET /repos/alice/app/issues/1/comments': fixtures.comments,
      'GET /repos/alice/app/pulls/1/reviews': fixtures.reviews,
      [`GET /repos/alice/app/pulls/1/reviews/${fixtures.reviews[1].id}/comments`]: fixtures.reviewComments,
      'GET /repos/alice/app/pulls/1/commits': fixtures.commits,
      'GET /repos/alice/app/raw/feature.js': (call) => (call.url.searchParams.get('ref') === HEAD ? 'export const feature = 2;\n' : 'old'),
    });

    await expect(service.changeRequestPatch('/repo', 1, { project: upstream, remote: 'origin' }))
      .resolves.toEqual({ patch: fixtures.forkPullDiff, meta: { owner: 'alice', repo: 'app', number: 1 } });
    await expect(service.changeRequestFileContents('/repo', 1, { project: upstream, remote: 'origin', path: 'feature.js', status: 'M' }))
      .resolves.toEqual({ original: 'old', modified: 'export const feature = 2;\n' });
    const result = await service.changeRequestContext('/repo', 1, { includeDiff: true, remote: 'origin' });
    expect(result.changeRequest).toMatchObject({ number: 1, headLabel: 'bob:feature', headProject: { id: '2', owner: 'bob' } });
    // No read went to the fork's own pull request or files.
    expect(calls.filter((call) => call.url.pathname.startsWith('/api/v1/repos/bob/app/')).map((call) => call.url.pathname)).toEqual([]);
  });

  it('comments on and merges the fork pull request', async () => {
    const { service, calls } = setupUpstream({
      'POST /repos/alice/app/issues/1/comments': { ...fixtures.comments[0], id: 77, body: 'Thanks' },
      'POST /repos/alice/app/pulls/1/merge': new Response(null, { status: 200 }),
    });

    const comment = await service.resolveChangeRequestMutation(context, { project: upstream, number: 1 });
    await expect(service.comment({ providerTarget: comment.providerTarget, body: 'Thanks' })).resolves.toEqual({});
    const merge = await service.resolveChangeRequestMutation(context, { project: upstream, number: 1, headSha: HEAD });
    expect(merge.target).toMatchObject({ project: { id: '1', owner: 'alice', name: 'app' }, number: 1, headSha: HEAD });
    await service.mergeChangeRequest({ providerTarget: merge.providerTarget, expectedTarget: merge.target, method: 'merge' });

    expect(calls.filter((call) => call.method === 'POST').map((call) => [call.url.pathname, call.body])).toEqual([
      ['/api/v1/repos/alice/app/issues/1/comments', { body: 'Thanks' }],
      ['/api/v1/repos/alice/app/pulls/1/merge', { Do: 'merge', head_commit_id: HEAD }],
    ]);
  });

  it('still refuses a pull request whose target is outside the network', async () => {
    const { service, calls } = setupUpstream({ 'GET /repos/bob/app/pulls/1': fixtures.forkPull });

    // bob/app is not in alice's network, so no selector reaches it.
    await expect(service.changeRequestPatch('/repo', 1, { project: { owner: 'bob', name: 'app' }, remote: 'origin' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.resolveChangeRequestMutation(context, { project: { owner: 'bob', name: 'app' }, number: 1 }))
      .rejects.toMatchObject({ status: 404 });
    expect(calls.some((call) => call.url.pathname.includes('/pulls/'))).toBe(false);
  });

  it('refuses a pull request the upstream answers with another base repository', async () => {
    const elsewhere = { ...fixtures.forkPull, base: { ...fixtures.forkPull.base, repo_id: 99 } };
    const { service } = setupUpstream({ 'GET /repos/alice/app/pulls/1': elsewhere });

    await expect(service.changeRequestPatch('/repo', 1, { project: upstream, remote: 'origin' }))
      .rejects.toThrow('Gitea returned a pull request of another repository');
  });
});

describe('Gitea mutations', () => {
  it('creates a cross-repository pull request with the fork owner on the head', async () => {
    const { service, calls } = setup({ 'POST /repos/alice/app/pulls': { ...fixtures.forkPull, number: 6 } });
    const resolved = await service.resolveCreateMutation(context, { project: upstream, head: 'feature', base: 'main' });

    const result = await service.createChangeRequest({
      providerTarget: resolved.providerTarget, expectedTarget: resolved.target, title: 'Add feature', draft: true, head: 'feature', base: 'main',
    });

    expect(result).toEqual({ number: 6 });
    expect(calls.find((call) => call.method === 'POST').body).toEqual({ head: 'bob:feature', base: 'main', title: 'WIP: Add feature' });
  });

  it('merges the reviewed head only, and names a moved head as a target mismatch', async () => {
    const moved = { ...fixtures.forkPull, head: { ...fixtures.forkPull.head, sha: 'e'.repeat(40) } };
    let reads = 0;
    const { service, calls } = setup({
      'GET /repos/alice/app/pulls/1': () => { reads += 1; return reads === 1 ? fixtures.forkPull : moved; },
      'POST /repos/alice/app/pulls/1/merge': () => replay(fixtures.errors.mergeHeadOutOfDate),
    });
    const resolved = await service.resolveChangeRequestMutation(context, { project: upstream, number: 1, headSha: HEAD });

    await expect(service.mergeChangeRequest({ providerTarget: resolved.providerTarget, expectedTarget: resolved.target, method: 'squash' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409 });
    expect(calls.find((call) => call.method === 'POST').body).toEqual({ Do: 'squash', head_commit_id: HEAD });
  });

  it('names a moved head a target mismatch when Gitea refuses the merge as unmergeable first', async () => {
    const moved = { ...fixtures.forkPull, mergeable: false, head: { ...fixtures.forkPull.head, sha: 'e'.repeat(40) } };
    const { service } = setup({
      'GET /repos/alice/app/pulls/1': moved,
      'POST /repos/alice/app/pulls/1/merge': () => replay(fixtures.errors.mergeUnmergeableStaleHead),
    });

    await expect(service.mergeChangeRequest({ providerTarget, expectedTarget: { headSha: HEAD }, method: 'merge' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409 });
  });

  it('passes a merge Gitea refuses for another reason through as its own failure', async () => {
    const { service } = setup({ 'POST /repos/alice/app/pulls/1/merge': () => replay(fixtures.errors.mergeWorkInProgress) });

    await expect(service.mergeChangeRequest({ providerTarget, expectedTarget: { headSha: HEAD }, method: 'merge' }))
      .rejects.toMatchObject({ status: 405, message: 'Work in progress PRs cannot be merged' });
  });

  it('refuses a mutation target whose head already moved', async () => {
    const { service } = setup();
    await expect(service.resolveChangeRequestMutation(context, { project: upstream, number: 1, headSha: 'f'.repeat(40) }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH' });
  });

  it('sets reviewers by id as the username additions and removals Gitea takes', async () => {
    const { service, calls } = setup({
      'GET /repos/alice/app/collaborators': fixtures.collaborators,
      // Alice's approval was dismissed, so removing her takes effect.
      'GET /repos/alice/app/pulls/1/reviews': fixtures.reviews.map((review) => (review.user.login === 'alice' ? { ...review, dismissed: true } : review)),
      'POST /repos/alice/app/pulls/1/requested_reviewers': [],
      'DELETE /repos/alice/app/pulls/1/requested_reviewers': new Response(null, { status: 204 }),
    });

    await service.setReviewers({ providerTarget, reviewers: ['2', '3'] });

    expect(calls.filter((call) => call.url.pathname.endsWith('requested_reviewers')).map((call) => [call.method, call.body])).toEqual([
      ['POST', { reviewers: ['bob'] }], ['DELETE', { reviewers: ['alice'] }],
    ]);
    await expect(service.setReviewers({ providerTarget, reviewers: ['404'] })).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to remove a reviewer who already reviewed, before sending anything', async () => {
    expect(fixtures.reviews.map((review) => [review.user.login, review.state])).toEqual([['alice', 'APPROVED'], ['carol', 'COMMENT']]);
    const { service, calls } = setup({
      'GET /repos/alice/app/collaborators': fixtures.collaborators,
      'GET /repos/alice/app/pulls/1/reviews': fixtures.reviews,
    });

    await expect(service.setReviewers({ providerTarget, reviewers: ['2', '3'] })).rejects.toMatchObject({
      status: 400, code: 'GITEA_REVIEWER_HAS_REVIEWED', message: 'alice already reviewed this pull request; Gitea keeps reviewers who reviewed',
    });
    await expect(service.setReviewers({ providerTarget, reviewers: [] })).rejects.toMatchObject({
      message: 'alice, carol already reviewed this pull request; Gitea keeps reviewers who reviewed',
    });
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('removes a reviewer whose only review entry is the request itself', async () => {
    const { service, calls } = setup({
      'GET /repos/alice/app/collaborators': fixtures.collaborators,
      'GET /repos/alice/app/pulls/1/reviews': fixtures.reviews.map((review) => (review.user.login === 'carol' ? { ...review, state: 'REQUEST_REVIEW' } : review)),
      'DELETE /repos/alice/app/pulls/1/requested_reviewers': new Response(null, { status: 204 }),
    });

    await service.setReviewers({ providerTarget, reviewers: ['1'] });

    expect(calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.body])).toEqual([['DELETE', { reviewers: ['carol'] }]]);
  });

  it('reconciles an emptied reviewer set from the null Gitea 1.21 answers', async () => {
    expect(fixtures.closedPull_1_21.requested_reviewers).toBeNull();
    const { service } = setup({ 'GET /repos/alice/app/pulls/4': fixtures.closedPull_1_21 });

    await expect(service.reconcileSetMutation({ ...providerTarget, number: 4 }, 'change-request-reviewers', []))
      .resolves.toEqual({ state: 'succeeded', result: {} });
  });

  it('reads an issue with its assignees, named by the reviewer candidate ids', async () => {
    const { service } = setup({ 'GET /repos/bob/app/issues/6': fixtures.issue });

    const issue = await service.getIssue('/repo', 6, { owner: 'bob', name: 'app' }, 'origin');
    expect(issue.assignees).toEqual([expect.objectContaining({ id: '1', username: 'alice' })]);
  });

  it('never reports an issue lock, which this module cannot write', async () => {
    // The preview offers its lock control wherever `locked` arrives, and Gitea's
    // lock API is past this module's supported versions: the flag stays out.
    const { service } = setup({ 'GET /repos/bob/app/issues/6': { ...fixtures.issue, is_locked: true } });
    const issue = await service.getIssue('/repo', 6, { owner: 'bob', name: 'app' }, 'origin');
    expect(issue).not.toHaveProperty('locked');
  });

  it('sets an issue assignee set by candidate id through the usernames Gitea takes, and verifies the answer', async () => {
    const answered = { ...fixtures.issue, number: 1, assignees: [fixtures.issue.assignees[0], fixtures.collaborators[0]] };
    const { service, calls } = setup({
      'GET /repos/alice/app/issues/1': { ...fixtures.issue, number: 1 },
      'GET /repos/alice/app/collaborators': fixtures.collaborators,
      'PATCH /repos/alice/app/issues/1': answered,
    });

    await expect(service.setIssueAssignees({ providerTarget: { ...providerTarget, number: 1 }, assignees: ['1', '2'] }))
      .resolves.toEqual({});
    expect(calls.find((call) => call.method === 'PATCH').body).toEqual({ assignees: ['alice', 'bob'] });
  });

  it('refuses an assignee Gitea does not know, before sending anything', async () => {
    const { service, calls } = setup({
      'GET /repos/alice/app/issues/1': { ...fixtures.issue, number: 1 },
      'GET /repos/alice/app/collaborators': fixtures.collaborators,
    });

    await expect(service.setIssueAssignees({ providerTarget: { ...providerTarget, number: 1 }, assignees: ['404'] }))
      .rejects.toMatchObject({ status: 422 });
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('refuses an answer whose assignee set is not the one asked', async () => {
    const { service } = setup({
      'GET /repos/alice/app/issues/1': { ...fixtures.issue, number: 1 },
      'GET /repos/alice/app/collaborators': fixtures.collaborators,
      'PATCH /repos/alice/app/issues/1': { ...fixtures.issue, number: 1 },
    });

    await expect(service.setIssueAssignees({ providerTarget: { ...providerTarget, number: 1 }, assignees: ['1', '2'] }))
      .rejects.toThrow('unexpected assignee set');
  });

  it('reconciles an assignee set only on an exact match', async () => {
    const { service } = setup({
      'GET /repos/alice/app/issues/1': { ...fixtures.issue, number: 1, assignees: [fixtures.issue.assignees[0], fixtures.collaborators[0]] },
      'GET /repos/alice/app/collaborators': fixtures.collaborators,
    });
    await expect(service.reconcileIssueAssignees({ ...providerTarget, number: 1 }, ['1', '2']))
      .resolves.toEqual({ state: 'succeeded', result: {} });
    await expect(service.reconcileIssueAssignees({ ...providerTarget, number: 1 }, ['1']))
      .resolves.toEqual({ state: 'outcome-unknown' });
  });

  it('sets labels by name through the repository label ids', async () => {
    const { service, calls } = setup({
      'GET /repos/alice/app/labels': fixtures.labels,
      'PUT /repos/alice/app/issues/1/labels': [fixtures.labels[1]],
    });

    await service.setLabels({ providerTarget, labels: ['ready'] });
    // Ids, because Gitea 1.21 refuses names there.
    expect(fixtures.errors.labelsByName_1_21.status).toBe(422);
    expect(calls.find((call) => call.method === 'PUT').body).toEqual({ labels: [2] });
  });

  it('reviews the commit the user read, after checking it is still the head', async () => {
    const { service, calls } = setup({
      'GET /repos/alice/app/pulls/1/reviews': [],
      'GET /user': { login: 'alice' },
      'POST /repos/alice/app/pulls/1/reviews': fixtures.reviews[0],
    });

    await expect(service.reviewChangeRequest({
      providerTarget, verdict: 'approve', body: 'Ship it', expectedTarget: { headSha: HEAD },
    })).resolves.toEqual({ commented: true });
    expect(calls.find((call) => call.method === 'POST').body).toEqual({ event: 'APPROVED', commit_id: HEAD, body: 'Ship it' });
  });

  describe('review drafts', () => {
    const pending = { id: 9, state: 'PENDING', user: { login: 'alice' }, body: '' };
    const draftRoutes = (reviews = [pending], comments = [{ id: 4, path: 'a.ts', body: 'Mine', position: 3, user: { login: 'alice' } }]) => ({
      'GET /user': { login: 'alice' },
      'GET /repos/alice/app/pulls/1/reviews': reviews,
      'GET /repos/alice/app/pulls/1/reviews/9/comments': comments,
    });
    const writes = (calls) => calls.filter((call) => call.method !== 'GET').map(({ method, path, body }) => ({ method, path, body }));

    it('adds a comment through the call that starts a pending review', async () => {
      const { service, calls } = setup({ 'POST /repos/alice/app/pulls/1/reviews': { id: 9 } });
      await service.addReviewComment({ providerTarget, position: { path: 'a.ts', side: 'old', line: 2 }, body: 'Gone', expectedTarget: { headSha: HEAD } });
      expect(calls.at(-1).body).toEqual({
        event: 'PENDING', commit_id: HEAD, body: '', comments: [{ path: 'a.ts', body: 'Gone', new_position: 0, old_position: 2 }],
      });
    });

    it('refuses a verdict on a draft from an older commit and still sends it as a comment', async () => {
      const stale = { ...pending, commit_id: 'older' };
      const { service, calls } = setup({ ...draftRoutes([stale]), 'POST /repos/alice/app/pulls/1/reviews/9': { id: 9 } });

      await expect(service.reviewChangeRequest({ providerTarget, verdict: 'approve', expectedTarget: { headSha: HEAD } })).rejects.toMatchObject({ status: 409 });
      expect(writes(calls)).toEqual([]);
      await service.reviewChangeRequest({ providerTarget, verdict: 'comment', expectedTarget: { headSha: HEAD } });
      expect(writes(calls)).toHaveLength(1);
    });

    it('says so when this version keeps a comment it was asked to remove', async () => {
      const { service } = setup({ ...draftRoutes(), 'DELETE /repos/alice/app/issues/comments/4': {} });

      await expect(service.deleteReviewComment({ providerTarget, commentId: '4' })).rejects.toMatchObject({ status: 422 });
    });

    it('sends the pending review with the verdict', async () => {
      const { service, calls } = setup({ ...draftRoutes(), 'POST /repos/alice/app/pulls/1/reviews/9': { id: 9 } });

      await service.reviewChangeRequest({ providerTarget, verdict: 'comment', expectedTarget: { headSha: HEAD } });

      expect(calls.at(-1).body).toEqual({ event: 'COMMENT', body: '' });
    });

    it('refuses an empty review and a comment that is not a draft of the viewer', async () => {
      const { service, calls } = setup(draftRoutes([]));

      await expect(service.reviewChangeRequest({ providerTarget, verdict: 'comment', expectedTarget: { headSha: HEAD } })).rejects.toMatchObject({ status: 422 });
      await expect(service.deleteReviewComment({ providerTarget, commentId: '4' })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID' });
      expect(writes(calls)).toEqual([]);
    });
  });

  it('converts a pull request to a draft by adding the WIP prefix, and reconciles it from the title', async () => {
    const draftPull = { ...fixtures.forkPull, title: 'WIP: Add feature' };
    const { service, calls } = setup({
      'GET /repos/alice/app/pulls/1': fixtures.forkPull,
      'PATCH /repos/alice/app/pulls/1': draftPull,
    });

    await expect(service.draftChangeRequest({ providerTarget, expectedTarget: { number: 1, headSha: HEAD } }))
      .resolves.toEqual({ draft: true });
    expect(calls.find((call) => call.method === 'PATCH').body).toEqual({ title: 'WIP: Add feature' });

    const drafted = setup({ 'GET /repos/alice/app/pulls/1': draftPull });
    await expect(drafted.service.reconcileChangeRequestMutation(providerTarget, 'change-request-draft'))
      .resolves.toMatchObject({ state: 'succeeded', result: { draft: true } });
  });

  it('reconciles a ready mutation from the title prefix', async () => {
    const { service } = setup({ 'GET /repos/alice/app/pulls/1': { ...fixtures.forkPull, title: 'WIP: Add feature' } });
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-ready'))
      .resolves.toMatchObject({ state: 'failed' });
  });

  describe('base changes', () => {
    const rebased = (base) => ({ ...fixtures.forkPull, base: { ...fixtures.forkPull.base, ref: base, label: base } });

    it('points a pull request at another base branch and reconciles only on that base', async () => {
      const { service, calls } = setup({
        'PATCH /repos/alice/app/pulls/1': rebased('release/2.0'),
        'GET /repos/alice/app/pulls/1': rebased('release/2.0'),
      });

      await expect(service.setChangeRequestBase({ providerTarget, base: 'release/2.0', expectedTarget: { number: 1, head: 'feature', headSha: HEAD, base: 'main' } }))
        .resolves.toEqual({});
      expect(calls.find((call) => call.method === 'PATCH').body).toEqual({ base: 'release/2.0' });

      await expect(service.reconcileChangeRequestBase(providerTarget, 'release/2.0'))
        .resolves.toEqual({ state: 'succeeded', result: {} });
      await expect(service.reconcileChangeRequestBase(providerTarget, 'main'))
        .resolves.toEqual({ state: 'outcome-unknown' });
    });

    it('refuses a pull request Gitea answered with another base', async () => {
      const { service } = setup({ 'PATCH /repos/alice/app/pulls/1': rebased('main') });

      await expect(service.setChangeRequestBase({ providerTarget, base: 'release/2.0', expectedTarget: { number: 1, head: 'feature', headSha: HEAD, base: 'main' } }))
        .rejects.toThrow('unexpected pull request base');
    });
  });

  describe('branch updates', () => {
    const updatePath = '/repos/alice/app/pulls/1/update';

    it('merges the base into the head through the update call, with the documented query style', async () => {
      const { service, calls } = setup({ ['POST ' + updatePath]: new Response(null, { status: 200 }) });

      await expect(service.updateChangeRequestBranch({ providerTarget, expectedTarget: { number: 1, headSha: HEAD }, expectedHeadSha: HEAD }))
        .resolves.toEqual({});
      const posts = calls.filter((call) => call.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0].url.pathname).toBe('/api/v1' + updatePath);
      expect(posts[0].url.searchParams.get('style')).toBe('merge');
      expect(posts[0].body).toBeUndefined();
    });

    it('refuses a branch that moved since the caller read it, before sending anything', async () => {
      const moved = { ...fixtures.forkPull, head: { ...fixtures.forkPull.head, sha: 'e'.repeat(40) } };
      const { service, calls } = setup({ 'GET /repos/alice/app/pulls/1': moved });

      await expect(service.updateChangeRequestBranch({ providerTarget, expectedTarget: { number: 1, headSha: HEAD }, expectedHeadSha: HEAD }))
        .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409 });
      expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });

    it('reconciles a branch update from a head that moved, and stays unknown on the old head', async () => {
      let current = { ...fixtures.forkPull, head: { ...fixtures.forkPull.head, sha: 'e'.repeat(40) } };
      const { service } = setup({ 'GET /repos/alice/app/pulls/1': () => current });

      await expect(service.reconcileChangeRequestBranch(providerTarget, HEAD)).resolves.toEqual({ state: 'succeeded', result: {} });
      current = fixtures.forkPull;
      await expect(service.reconcileChangeRequestBranch(providerTarget, HEAD)).resolves.toEqual({ state: 'outcome-unknown' });
    });

    it('surfaces Gitea refusing the update as its own failure', async () => {
      for (const [status, message] of [[409, 'merge failed because of conflict'], [400, 'merge request is not open']]) {
        const { service } = setup({
          ['POST ' + updatePath]: new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } }),
        });

        await expect(service.updateChangeRequestBranch({ providerTarget, expectedTarget: { number: 1, headSha: HEAD }, expectedHeadSha: HEAD }))
          .rejects.toMatchObject({ status, message });
      }
    });
  });

  describe('issue updates', () => {
    const issueTarget = { ...providerTarget, number: fixtures.issue.number };
    const issuePath = `/repos/alice/app/issues/${fixtures.issue.number}`;
    const patched = (extra = {}) => ({ ...fixtures.issue, title: 'Startup crash', body: 'Fixed by upgrading.', ...extra });

    it('replaces the title and body through the issue a pull request also is', async () => {
      const { service, calls } = setup({ [`PATCH ${issuePath}`]: patched() });

      await expect(service.updateIssue({
        providerTarget: issueTarget, expectedTarget: { number: issueTarget.number }, title: 'Startup crash', body: 'Fixed by upgrading.',
      })).resolves.toEqual({});

      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch.url.pathname).toBe(`/api/v1${issuePath}`);
      expect(patch.body).toEqual({ title: 'Startup crash', body: 'Fixed by upgrading.' });
    });

    it('sends the title alone when no body is asked for', async () => {
      const { service, calls } = setup({ [`PATCH ${issuePath}`]: patched({ body: fixtures.issue.body }) });

      await expect(service.updateIssue({ providerTarget: issueTarget, expectedTarget: { number: issueTarget.number }, title: 'Startup crash' }))
        .resolves.toEqual({});
      expect(calls.find((call) => call.method === 'PATCH').body).toEqual({ title: 'Startup crash' });
    });

    it('refuses a response that does not restate the title or body asked for', async () => {
      const staleTitle = setup({ [`PATCH ${issuePath}`]: patched({ title: 'Something else' }) });
      await expect(staleTitle.service.updateIssue({
        providerTarget: issueTarget, expectedTarget: { number: issueTarget.number }, title: 'Startup crash', body: 'Fixed by upgrading.',
      })).rejects.toThrow('Gitea returned an unexpected issue title or body');

      const staleBody = setup({ [`PATCH ${issuePath}`]: patched({ body: 'Still broken.' }) });
      await expect(staleBody.service.updateIssue({
        providerTarget: issueTarget, expectedTarget: { number: issueTarget.number }, title: 'Startup crash', body: 'Fixed by upgrading.',
      })).rejects.toThrow('Gitea returned an unexpected issue title or body');
    });

    it('refuses a response for another issue number', async () => {
      const { service } = setup({ [`PATCH ${issuePath}`]: patched({ number: issueTarget.number + 1 }) });

      await expect(service.updateIssue({
        providerTarget: issueTarget, expectedTarget: { number: issueTarget.number }, title: 'Startup crash', body: 'Fixed by upgrading.',
      })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409 });
    });

    it('reconciles the edit only from the values it reads back', async () => {
      const exact = setup({ [`GET ${issuePath}`]: patched() });
      await expect(exact.service.reconcileIssueUpdate(issueTarget, 'Startup crash', 'Fixed by upgrading.'))
        .resolves.toEqual({ state: 'succeeded', result: {} });

      const titleOnly = setup({ [`GET ${issuePath}`]: patched() });
      await expect(titleOnly.service.reconcileIssueUpdate(issueTarget, 'Startup crash', undefined))
        .resolves.toEqual({ state: 'succeeded', result: {} });

      const otherTitle = setup({ [`GET ${issuePath}`]: patched({ title: 'Something else' }) });
      await expect(otherTitle.service.reconcileIssueUpdate(issueTarget, 'Startup crash', 'Fixed by upgrading.'))
        .resolves.toEqual({ state: 'outcome-unknown' });

      const otherBody = setup({ [`GET ${issuePath}`]: patched({ body: 'Still broken.' }) });
      await expect(otherBody.service.reconcileIssueUpdate(issueTarget, 'Startup crash', 'Fixed by upgrading.'))
        .resolves.toEqual({ state: 'outcome-unknown' });
    });
  });

  describe('issue subscriptions', () => {
    const checkPath = 'GET /repos/alice/app/issues/1/subscriptions/check';

    it('follows and unfollows the acting account by its login', async () => {
      const { service, calls } = setup({
        'PUT /repos/alice/app/issues/1/subscriptions/alice': new Response(null, { status: 204 }),
        'DELETE /repos/alice/app/issues/1/subscriptions/alice': new Response(null, { status: 204 }),
      });

      await expect(service.setSubscription({ providerTarget, subscribed: true })).resolves.toEqual({});
      await expect(service.setSubscription({ providerTarget, subscribed: false })).resolves.toEqual({});

      expect(calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.url.pathname])).toEqual([
        ['PUT', '/api/v1/repos/alice/app/issues/1/subscriptions/alice'],
        ['DELETE', '/api/v1/repos/alice/app/issues/1/subscriptions/alice'],
      ]);
    });

    it('acts on the pull request number the resolver reads', async () => {
      const { service, calls } = setup({ 'PUT /repos/alice/app/issues/1/subscriptions/alice': new Response(null, { status: 204 }) });

      const resolved = await service.resolveChangeRequestMutation(context, { project: upstream, number: 1 });
      await service.setSubscription({ providerTarget: resolved.providerTarget, subscribed: true });

      expect(calls.find((call) => call.method === 'PUT').url.pathname).toBe('/api/v1/repos/alice/app/issues/1/subscriptions/alice');
    });

    it('reconciles only an exact answer from the check', async () => {
      const { service } = setup({ [checkPath]: { subscribed: true } });

      await expect(service.reconcileSubscription(providerTarget, true)).resolves.toEqual({ state: 'succeeded', result: {} });
      await expect(service.reconcileSubscription(providerTarget, false)).resolves.toEqual({ state: 'outcome-unknown' });

      const unreadable = setup({ [checkPath]: () => new Response('{}', { status: 500 }) });
      await expect(unreadable.service.reconcileSubscription(providerTarget, true)).resolves.toEqual({ state: 'outcome-unknown' });
    });

    it('carries the follow flag on an issue detail read only when Gitea answers', async () => {
      const { service, calls } = setup({
        'GET /repos/bob/app/issues/6': fixtures.issue,
        'GET /repos/bob/app/issues/6/subscriptions/check': { subscribed: true },
      });

      const followed = await service.getIssue('/repo', 6, { owner: 'bob', name: 'app' }, 'origin');
      expect(followed.subscribed).toBe(true);
      expect(calls.filter((call) => call.url.pathname.endsWith('/subscriptions/check'))).toHaveLength(1);

      const { service: unreadable } = setup({
        'GET /repos/bob/app/issues/6': fixtures.issue,
        'GET /repos/bob/app/issues/6/subscriptions/check': () => new Response('{}', { status: 500 }),
      });
      const answer = await unreadable.getIssue('/repo', 6, { owner: 'bob', name: 'app' }, 'origin');
      expect(answer).not.toHaveProperty('subscribed');
    });
  });

  describe('conversation comments', () => {
    const commentPath = '/repos/alice/app/issues/comments/41';
    // Gitea answers the HTML address, not the API path; a pull request comment
    // leaves `issue_url` empty and names the pull request instead.
    const onIssue = (number, body = 'Old text') => ({
      id: 41, body, issue_url: `${ORIGIN}/alice/app/issues/${number}`,
    });
    const onPull = (number, body = 'Old text') => ({
      id: 41, body, issue_url: '', pull_request_url: `${ORIGIN}/alice/app/pulls/${number}`,
    });
    const writes = (calls) => calls.filter((call) => call.method !== 'GET');
    const conflict = { code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', status: 409 };

    it('edits the comment on the target issue, requiring the answered body', async () => {
      const { service, calls } = setup({
        [`GET ${commentPath}`]: onIssue(1),
        [`PATCH ${commentPath}`]: onIssue(1, 'Fixed'),
      });

      await expect(service.updateIssueComment({
        providerTarget, expectedTarget: { number: 1 }, commentId: '41', body: 'Fixed',
      })).resolves.toEqual({});

      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch.url.pathname).toBe(`/api/v1${commentPath}`);
      expect(patch.body).toEqual({ body: 'Fixed' });
      // The comment is read first, so a foreign id is refused before any write.
      expect(calls[0].method).toBe('GET');
    });

    it('refuses an answered body that differs from the one asked for', async () => {
      const { service } = setup({
        [`GET ${commentPath}`]: onIssue(1),
        [`PATCH ${commentPath}`]: onIssue(1, 'Still old'),
      });

      await expect(service.updateIssueComment({
        providerTarget, expectedTarget: { number: 1 }, commentId: '41', body: 'Fixed',
      })).rejects.toThrow('Gitea returned an unexpected comment body');
    });

    it('accepts a pull request comment, whose issue_url is empty', async () => {
      const { service } = setup({
        [`GET ${commentPath}`]: onPull(1),
        [`PATCH ${commentPath}`]: onPull(1, 'Fixed'),
      });

      await expect(service.updateIssueComment({
        providerTarget, expectedTarget: { number: 1 }, commentId: '41', body: 'Fixed',
      })).resolves.toEqual({});
    });

    it('refuses a comment whose address names another item, with no write', async () => {
      for (const foreign of [
        onIssue(2),
        onPull(2),
        { ...onIssue(1), issue_url: 'https://gitea.example.com/bob/app/issues/1' },
        { ...onIssue(1), issue_url: 'https://elsewhere.example.com/alice/app/issues/1' },
        { id: 41, body: 'Old text' },
      ]) {
        const { service, calls } = setup({ [`GET ${commentPath}`]: foreign });

        await expect(service.updateIssueComment({
          providerTarget, expectedTarget: { number: 1 }, commentId: '41', body: 'Fixed',
        })).rejects.toMatchObject(conflict);
        await expect(service.deleteIssueComment({
          providerTarget, expectedTarget: { number: 1 }, commentId: '41',
        })).rejects.toMatchObject(conflict);
        expect(writes(calls)).toEqual([]);
      }
    });

    it('deletes the comment and confirms it through a follow-up read that answers 404', async () => {
      let deleted = false;
      const { service, calls } = setup({
        [`GET ${commentPath}`]: () => (deleted
          ? new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
          : onIssue(1)),
        [`DELETE ${commentPath}`]: () => {
          deleted = true;
          return {};
        },
      });

      await expect(service.deleteIssueComment({
        providerTarget, expectedTarget: { number: 1 }, commentId: '41',
      })).resolves.toEqual({});

      const del = calls.find((call) => call.method === 'DELETE');
      expect(del.url.pathname).toBe(`/api/v1${commentPath}`);
      expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET']);
    });

    it('leaves a delete whose comment is still readable afterwards unknown, never failed', async () => {
      const { service } = setup({
        [`GET ${commentPath}`]: onIssue(1),
        [`DELETE ${commentPath}`]: {},
      });

      const refusal = await service.deleteIssueComment({
        providerTarget, expectedTarget: { number: 1 }, commentId: '41',
      }).then(() => null, (error) => error);
      expect(refusal?.message).toBe('Gitea kept a comment it was asked to delete');
      // No status: a stale read looks like a lost write, so the shell records outcome-unknown.
      expect(refusal?.status).toBeUndefined();
    });

    it('reconciles an edit only on the exact body, never as a definite failure', async () => {
      const exact = setup({ [`GET ${commentPath}`]: onIssue(1, 'Fixed') });
      await expect(exact.service.reconcileIssueCommentUpdate(providerTarget, '41', 'Fixed'))
        .resolves.toEqual({ state: 'succeeded', result: {} });

      const other = setup({ [`GET ${commentPath}`]: onIssue(1, 'Something else') });
      await expect(other.service.reconcileIssueCommentUpdate(providerTarget, '41', 'Fixed'))
        .resolves.toEqual({ state: 'outcome-unknown' });

      const gone = setup({});
      await expect(gone.service.reconcileIssueCommentUpdate(providerTarget, '41', 'Fixed'))
        .resolves.toEqual({ state: 'outcome-unknown' });
    });

    it('reconciles a delete from the follow-up read: 404 is gone, present or unreadable is unknown', async () => {
      const gone = setup({});
      await expect(gone.service.reconcileIssueCommentDelete(providerTarget, '41'))
        .resolves.toEqual({ state: 'succeeded', result: {} });

      const present = setup({ [`GET ${commentPath}`]: onIssue(1) });
      await expect(present.service.reconcileIssueCommentDelete(providerTarget, '41'))
        .resolves.toEqual({ state: 'outcome-unknown' });

      const unreadable = setup({
        [`GET ${commentPath}`]: () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
      });
      await expect(unreadable.service.reconcileIssueCommentDelete(providerTarget, '41'))
        .resolves.toEqual({ state: 'outcome-unknown' });
    });
  });
});

describe('Gitea label filtering', () => {
  it('asks the issue list for each label, comma-joined and in order', async () => {
    const { service, calls } = setup({ 'GET /repos/bob/app/issues': () => pullsPage([]) });

    await service.listIssues('/repo', { labels: ['bug'] });
    const one = calls.filter((call) => call.url.pathname === '/api/v1/repos/bob/app/issues').at(-1);
    expect(one.url.searchParams.get('labels')).toBe('bug');

    await service.listIssues('/repo', { labels: ['bug', 'needs review'] });
    const two = calls.filter((call) => call.url.pathname === '/api/v1/repos/bob/app/issues').at(-1);
    expect(two.url.searchParams.get('labels')).toBe('bug,needs review');
    expect(two.url.searchParams.getAll('labels')).toEqual(['bug,needs review']);
  });

  it('reads a labelled pull list through the issue list, never the pull list that combines labels with OR', async () => {
    const { service, calls } = setup({
      'GET /repos/alice/app/pulls': () => pullsPage([]),
      'GET /repos/alice/app/issues': () => pullsPage([]),
    });

    await service.listChangeRequests('/repo', { labels: ['bug'] });
    const one = calls.filter((call) => call.url.pathname === '/api/v1/repos/alice/app/issues').at(-1);
    expect(one.url.searchParams.get('type')).toBe('pulls');
    expect(one.url.searchParams.get('labels')).toBe('bug');

    await service.listChangeRequests('/repo', { labels: ['bug', 'needs review'] });
    const two = calls.filter((call) => call.url.pathname === '/api/v1/repos/alice/app/issues').at(-1);
    expect(two.url.searchParams.get('labels')).toBe('bug,needs review');
    expect(two.url.searchParams.getAll('labels')).toEqual(['bug,needs review']);
    expect(calls.some((call) => call.url.pathname === '/api/v1/repos/alice/app/pulls')).toBe(false);
  });

  it('narrows a labelled issue page by name, which Gitea would otherwise answer unfiltered', async () => {
    // Gitea drops a label name the repository does not have; with every name
    // dropped it answers the whole list while the filter chip still shows.
    const { service } = setup({
      'GET /repos/bob/app/issues': () => pullsPage([
        { ...fixtures.issue, number: 5, title: 'Labelled', labels: [{ name: 'bug' }] },
        { ...fixtures.issue, number: 6, title: 'Not labelled', labels: [] },
      ]),
    });

    const page = await service.listIssues('/repo', { labels: ['gone-from-this-repository'] });
    expect(page.items.map((item) => item.number)).toEqual([]);
    const kept = await service.listIssues('/repo', { labels: ['bug'] });
    expect(kept.items.map((item) => item.number)).toEqual([5]);
  });

  it('narrows a labelled pull page read through the issue list the same way', async () => {
    const { service } = setup({
      'GET /repos/alice/app/pulls': () => pullsPage([]),
      'GET /repos/alice/app/issues': () => pullsPage([
        { number: 9, title: 'Labelled', labels: [{ name: 'bug' }] },
        { number: 8, title: 'Not labelled', labels: [] },
      ]),
      'GET /repos/alice/app/pulls/9': { ...fixtures.forkPull, number: 9 },
    });

    const page = await service.listChangeRequests('/repo', { labels: ['bug'] });
    expect(page.items.map((item) => item.number)).toEqual([9]);
  });

  it('finishes the review-requested search with AND, which Gitea combines with OR', async () => {
    const { service, calls } = setup({
      'GET /repos/issues/search': () => pullsPage([
        { repository: { id: 1 }, number: 9, labels: [{ name: 'bug' }, { name: 'needs review' }] },
        { repository: { id: 1 }, number: 8, labels: [{ name: 'bug' }] },
        { repository: { id: 2 }, number: 7, labels: [{ name: 'bug' }, { name: 'needs review' }] },
      ]),
      'GET /repos/alice/app/pulls/9': { ...fixtures.forkPull, number: 9 },
    });

    const page = await service.listChangeRequests('/repo', { people: 'reviewRequested', labels: ['bug', 'needs review'] });

    const search = calls.find((call) => call.url.pathname === '/api/v1/repos/issues/search');
    expect(search.url.searchParams.get('labels')).toBe('bug,needs review');
    expect(page.items.map((item) => item.number)).toEqual([9]);
  });

  it('sends no label parameter for an empty filter', async () => {
    const { service, calls } = setup({
      'GET /repos/alice/app/pulls': () => pullsPage([]),
      'GET /repos/bob/app/issues': () => pullsPage([]),
    });
    await service.listChangeRequests('/repo', { labels: [] });
    expect(calls.filter((call) => call.url.pathname === '/api/v1/repos/alice/app/pulls').at(-1).url.searchParams.has('labels')).toBe(false);
    await service.listIssues('/repo', {});
    expect(calls.filter((call) => call.url.pathname === '/api/v1/repos/bob/app/issues').at(-1).url.searchParams.has('labels')).toBe(false);
  });

  it('refuses a label containing a comma before any provider call', async () => {
    const { service, calls } = setup();
    await expect(service.listChangeRequests('/repo', { labels: ['bug,docs'] }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400 });
    await expect(service.listIssues('/repo', { labels: ['bug,docs'] }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe('Gitea cross-references', () => {
  const timelineEntry = (overrides = {}) => ({
    id: 1,
    type: 'issue_ref',
    ref_issue: {
      id: 12,
      number: 12,
      title: 'Related bug',
      html_url: `${ORIGIN}/bob/app/issues/12`,
      repository: { full_name: 'bob/app' },
      pull_request: null,
    },
    ref_action: 'close',
    user: { id: 3, login: 'carol', avatar_url: `${ORIGIN}/avatars/carol` },
    created_at: '2026-10-23T10:00:00+03:00',
    ...overrides,
  });
  const author = { login: 'carol', avatarUrl: `${ORIGIN}/avatars/carol` };

  it("reads an issue's cross-references from its timeline", async () => {
    const { service, calls } = setup({
      'GET /repos/bob/app/issues/6': fixtures.issue,
      'GET /repos/bob/app/issues/6/timeline': [timelineEntry()],
    });

    const issue = await service.getIssue('/repo', 6, undefined, 'origin');

    expect(issue.references).toEqual([{
      kind: 'issue',
      number: 12,
      title: 'Related bug',
      url: `${ORIGIN}/bob/app/issues/12`,
      repo: 'bob/app',
      createdAt: '2026-10-23T10:00:00+03:00',
      author,
    }]);
    const read = calls.find((call) => call.url.pathname === '/api/v1/repos/bob/app/issues/6/timeline');
    expect(read.url.searchParams.get('limit')).toBe('50');
  });

  it("adds a pull request timeline's references only when the timeline asks, a cross-repository one included", async () => {
    const { service } = setup({
      'GET /repos/alice/app/pulls/1.diff': fixtures.forkPullDiff,
      'GET /repos/alice/app/pulls/1/files': fixtures.forkPullFiles,
      'GET /repos/alice/app/issues/1/comments': fixtures.comments,
      'GET /repos/alice/app/pulls/1/reviews': fixtures.reviews,
      [`GET /repos/alice/app/pulls/1/reviews/${fixtures.reviews[1].id}/comments`]: fixtures.reviewComments,
      'GET /repos/alice/app/pulls/1/commits': fixtures.commits,
      'GET /repos/alice/app/issues/1/timeline': [
        timelineEntry({
          type: 'pull_ref',
          ref_issue: {
            id: 7, number: 7, title: 'Follow-up', html_url: `${ORIGIN}/alice/app/pulls/7`, repository: { full_name: 'alice/app' }, pull_request: {},
          },
        }),
        timelineEntry({
          id: 2,
          ref_issue: {
            id: 3, number: 3, title: 'Upstream bug', html_url: `${ORIGIN}/carol/lib/issues/3`, repository: { full_name: 'carol/lib' }, pull_request: null,
          },
        }),
      ],
    });

    const plain = await service.changeRequestContext('/repo', 1, { remote: 'origin' });
    expect(plain).not.toHaveProperty('references');

    const result = await service.changeRequestContext('/repo', 1, { includeTimeline: true, remote: 'origin' });
    expect(result.references).toEqual([
      {
        kind: 'pull', number: 7, title: 'Follow-up', url: `${ORIGIN}/alice/app/pulls/7`, repo: 'alice/app', createdAt: '2026-10-23T10:00:00+03:00', author,
      },
      {
        kind: 'issue', number: 3, title: 'Upstream bug', url: `${ORIGIN}/carol/lib/issues/3`, repo: 'carol/lib', createdAt: '2026-10-23T10:00:00+03:00', author,
      },
    ]);
  });

  it('ignores timeline events that name no readable item', async () => {
    const { service } = setup({
      'GET /repos/bob/app/issues/6': fixtures.issue,
      'GET /repos/bob/app/issues/6/timeline': [
        // Comments, commits and the rest of the timeline are not references.
        timelineEntry({ id: 1, type: 'comment_ref' }),
        timelineEntry({ id: 2, type: 'commit_ref' }),
        // A reference the timeline names without a number or a URL is dropped.
        timelineEntry({ id: 3, ref_issue: { number: '12', html_url: `${ORIGIN}/bob/app/issues/12` } }),
        timelineEntry({ id: 4, ref_issue: { number: 12 } }),
        timelineEntry({ id: 5, ref_issue: undefined }),
      ],
    });

    const issue = await service.getIssue('/repo', 6, undefined, 'origin');
    expect(issue).not.toHaveProperty('references');
  });

  it('keeps an issue readable when its timeline cannot be read', async () => {
    const { service } = setup({
      'GET /repos/bob/app/issues/6': fixtures.issue,
      'GET /repos/bob/app/issues/6/timeline': () => new Response('{}', { status: 500 }),
    });

    const issue = await service.getIssue('/repo', 6, undefined, 'origin');
    expect(issue).toMatchObject({ number: 6 });
    expect(issue).not.toHaveProperty('references');
  });
});
