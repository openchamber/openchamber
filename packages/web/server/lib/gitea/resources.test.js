import { describe, expect, it } from 'vitest';
import { createGiteaClient } from './client.js';
import { createGiteaResourceService } from './resources.js';
import { fakeGitea, fixtures, forkNetworkRoutes, ORIGIN, resolveForkRemote } from './fixtures/fake-fetch.js';

const HEAD = 'a'.repeat(40);
const pullsPage = (items, more = false) => new Response(JSON.stringify(items), {
  headers: more ? { link: '<next>; rel="next"' } : {},
});
const context = { repositoryId: 'repo-1', bindingRevision: 2, primaryRemote: 'origin', directory: '/repo' };

function setup(extra = {}) {
  // The fork itself has no pull requests of its own.
  const gitea = fakeGitea(forkNetworkRoutes({ 'GET /repos/alice/app/pulls': () => pullsPage([]), ...extra }));
  const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch: gitea.fetch, delay: async () => {} });
  return { ...gitea, service: createGiteaResourceService({ origin: ORIGIN, client, resolveRepos: resolveForkRemote }) };
}


describe('Gitea change request status', () => {
  it('finds a fork pull request in the upstream by base and head', async () => {
    const { service, calls } = setup({ 'GET /repos/team/app/pulls/main/alice:feature': fixtures.forkPull });

    const status = await service.changeRequestStatus('/repo', 'feature', 'origin');

    expect(status).toMatchObject({
      project: { id: '10', owner: 'team', name: 'app' },
      changeRequest: { number: 5, state: 'open', head: 'feature', headSha: HEAD },
      ci: { summary: { state: 'pending', total: 2 } },
      canMerge: true,
      resolvedRemoteName: 'origin',
    });
    expect(calls.some((call) => call.url.pathname === '/api/v1/repos/team/app/pulls')).toBe(false);
  });

  it('falls back to scanning open pull requests when the direct lookup finds none', async () => {
    const { service } = setup({
      'GET /repos/team/app/pulls': (call) => (call.url.searchParams.get('page') === '1'
        ? pullsPage([{ ...fixtures.forkPull, number: 4, head: { ...fixtures.forkPull.head, ref: 'other' } }], true)
        : pullsPage([fixtures.forkPull])),
    });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).resolves.toMatchObject({ changeRequest: { number: 5 } });
  });

  it('answers no pull request only after a complete scan', async () => {
    const { service } = setup({ 'GET /repos/team/app/pulls': () => pullsPage([]) });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).resolves.toMatchObject({
      changeRequest: null, project: { id: '11', owner: 'alice' },
    });
  });

  it('fails rather than answer "no pull request" when the scan hits its bound', async () => {
    const { service } = setup({
      'GET /repos/team/app/pulls': () => pullsPage([{ ...fixtures.forkPull, head: { ...fixtures.forkPull.head, ref: 'other' } }], true),
    });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).rejects.toThrow('more open pull requests');
  });

  it('propagates a failed lookup instead of an empty status', async () => {
    const { service } = setup({ 'GET /repos/alice/app/pulls': () => new Response('{}', { status: 500 }) });

    await expect(service.changeRequestStatus('/repo', 'feature', 'origin')).rejects.toMatchObject({ status: 500 });
  });
});

describe('Gitea change request context', () => {
  it('reads the diff per file, comments, reviews, commits and verdicts', async () => {
    const { service } = setup({
      'GET /repos/team/app/pulls/5.diff': fixtures.diff,
      'GET /repos/team/app/pulls/5/files': fixtures.files,
      'GET /repos/team/app/issues/5/comments': fixtures.comments,
      'GET /repos/team/app/pulls/5/reviews': fixtures.reviews,
      'GET /repos/team/app/pulls/5/reviews/30/comments': fixtures.reviewComments,
      'GET /repos/team/app/pulls/5/commits': fixtures.commits,
    });

    const result = await service.changeRequestContext('/repo', 5, { includeDiff: true, includeTimeline: true, remote: 'origin' });

    expect(result.changeRequest).toMatchObject({ number: 5, headProject: { id: '11', owner: 'alice' } });
    expect(result.files.map((file) => [file.path, file.status, Boolean(file.patch)])).toEqual([
      ['src/app.js', 'modified', true], ['old.txt', 'removed', true],
    ]);
    expect(result.issueComments.map((comment) => comment.body)).toEqual(['First!', 'Looks good']);
    expect(result.reviewComments).toEqual([expect.objectContaining({ path: 'src/app.js', line: 2, body: 'Nit' })]);
    expect(result.commits.map((commit) => commit.headline)).toEqual(['Start feature', 'Finish feature']);
    expect(result.commitsComplete).toBe(true);
    expect(result.verdicts).toEqual([expect.objectContaining({ state: 'approved' })]);
    expect(result.reviewers).toEqual([expect.objectContaining({ id: '8', username: 'bob' })]);
  });

  it('refuses a pull request whose head comes from outside the bound network', async () => {
    const foreign = { ...fixtures.forkPull, head: { ...fixtures.forkPull.head, repo_id: 99, repo: null } };
    const { service } = setup({ 'GET /repos/team/app/pulls/5': foreign });

    await expect(service.changeRequestPatch('/repo', 5, { remote: 'origin' })).rejects.toMatchObject({ status: 404 });
  });

  it('reads both sides of a file at the merge base and the head', async () => {
    const { service, calls } = setup({
      'GET /repos/team/app/raw/src/app.js': (call) => (call.url.searchParams.get('ref') === HEAD ? 'new' : 'old'),
    });

    await expect(service.changeRequestFileContents('/repo', 5, { remote: 'origin', path: 'src/app.js', status: 'M' }))
      .resolves.toEqual({ original: 'old', modified: 'new' });
    expect(calls.filter((call) => call.url.pathname.includes('/raw/')).map((call) => call.url.searchParams.get('ref')).sort())
      .toEqual(['b'.repeat(40), HEAD].sort());
  });
});

describe('Gitea mutations', () => {
  it('creates a cross-repository pull request with the fork owner on the head', async () => {
    const { service, calls } = setup({ 'POST /repos/team/app/pulls': { ...fixtures.forkPull, number: 6 } });
    const resolved = await service.resolveCreateMutation(context, { project: { owner: 'team', name: 'app' }, head: 'feature', base: 'main' });

    const result = await service.createChangeRequest({
      providerTarget: resolved.providerTarget, expectedTarget: resolved.target, title: 'Add feature', draft: true, head: 'feature', base: 'main',
    });

    expect(result).toEqual({ number: 6 });
    expect(calls.find((call) => call.method === 'POST').body).toEqual({ head: 'alice:feature', base: 'main', title: 'WIP: Add feature' });
  });

  it('merges the reviewed head only, and names a moved head as a target mismatch', async () => {
    const moved = { ...fixtures.forkPull, head: { ...fixtures.forkPull.head, sha: 'e'.repeat(40) } };
    let reads = 0;
    const { service, calls } = setup({
      'GET /repos/team/app/pulls/5': () => { reads += 1; return reads === 1 ? fixtures.forkPull : moved; },
      'POST /repos/team/app/pulls/5/merge': new Response(JSON.stringify({ message: 'head out of date' }), { status: 409 }),
    });
    const resolved = await service.resolveChangeRequestMutation(context, { project: { owner: 'team', name: 'app' }, number: 5, headSha: HEAD });

    await expect(service.mergeChangeRequest({ providerTarget: resolved.providerTarget, expectedTarget: resolved.target, method: 'squash' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409 });
    expect(calls.find((call) => call.method === 'POST').body).toEqual({ Do: 'squash', head_commit_id: HEAD });
  });

  it('refuses a mutation target whose head already moved', async () => {
    const { service } = setup();
    await expect(service.resolveChangeRequestMutation(context, { project: { owner: 'team', name: 'app' }, number: 5, headSha: 'f'.repeat(40) }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH' });
  });

  it('sets reviewers by id as the username additions and removals Gitea takes', async () => {
    const { service, calls } = setup({
      'GET /repos/team/app/collaborators': fixtures.collaborators,
      'POST /repos/team/app/pulls/5/requested_reviewers': [],
      'DELETE /repos/team/app/pulls/5/requested_reviewers': new Response(null, { status: 204 }),
    });
    const providerTarget = { repoId: 10, owner: 'team', name: 'app', number: 5 };

    await service.setReviewers({ providerTarget, reviewers: ['9'] });

    expect(calls.filter((call) => call.url.pathname.endsWith('requested_reviewers')).map((call) => [call.method, call.body])).toEqual([
      ['POST', { reviewers: ['carol'] }], ['DELETE', { reviewers: ['bob'] }],
    ]);
    await expect(service.setReviewers({ providerTarget, reviewers: ['404'] })).rejects.toMatchObject({ status: 422 });
  });

  it('sets labels by name through the repository label ids', async () => {
    const { service, calls } = setup({
      'GET /repos/team/app/labels': fixtures.labels,
      'PUT /repos/team/app/issues/5/labels': [fixtures.labels[1]],
    });

    await service.setLabels({ providerTarget: { repoId: 10, owner: 'team', name: 'app', number: 5 }, labels: ['ready'] });
    expect(calls.find((call) => call.method === 'PUT').body).toEqual({ labels: [2] });
  });

  it('reviews the commit the user read, after checking it is still the head', async () => {
    const { service, calls } = setup({ 'POST /repos/team/app/pulls/5/reviews': { id: 50, state: 'APPROVED' } });

    await expect(service.reviewChangeRequest({
      providerTarget: { repoId: 10, owner: 'team', name: 'app', number: 5 }, verdict: 'approve', body: 'Ship it', expectedTarget: { headSha: HEAD },
    })).resolves.toEqual({ commented: true });
    expect(calls.find((call) => call.method === 'POST').body).toEqual({ event: 'APPROVED', commit_id: HEAD, body: 'Ship it' });
  });

  it('reconciles a ready mutation from the title prefix', async () => {
    const { service } = setup({ 'GET /repos/team/app/pulls/5': { ...fixtures.forkPull, title: 'WIP: Add feature' } });
    await expect(service.reconcileChangeRequestMutation({ repoId: 10, owner: 'team', name: 'app', number: 5 }, 'change-request-ready'))
      .resolves.toMatchObject({ state: 'failed' });
  });
});
