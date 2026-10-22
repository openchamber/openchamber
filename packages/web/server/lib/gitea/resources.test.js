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

  it('refuses a pull request whose head comes from outside the bound network', async () => {
    const foreign = { ...fixtures.forkPull, head: { ...fixtures.forkPull.head, repo_id: 99, repo: null } };
    const { service } = setup({ 'GET /repos/alice/app/pulls/1': foreign });

    await expect(service.changeRequestPatch('/repo', 1, { remote: 'origin' })).rejects.toMatchObject({ status: 404 });
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
    const { service, calls } = setup({ 'POST /repos/alice/app/pulls/1/reviews': fixtures.reviews[0] });

    await expect(service.reviewChangeRequest({
      providerTarget, verdict: 'approve', body: 'Ship it', expectedTarget: { headSha: HEAD },
    })).resolves.toEqual({ commented: true });
    expect(calls.find((call) => call.method === 'POST').body).toEqual({ event: 'APPROVED', commit_id: HEAD, body: 'Ship it' });
  });

  it('reconciles a ready mutation from the title prefix', async () => {
    const { service } = setup({ 'GET /repos/alice/app/pulls/1': { ...fixtures.forkPull, title: 'WIP: Add feature' } });
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-ready'))
      .resolves.toMatchObject({ state: 'failed' });
  });
});
