import { describe, expect, it } from 'vitest';
import { createGerritClient } from './client.js';
import { createGerritResourceService, selectChangeForBranch } from './resources.js';
import {
  CHANGE, changeRoutes, fakeGerrit, fixtures, gerritBase64, ORIGIN, PS2, PS3, replay, resolvePlatformApp,
} from './fixtures/fake-fetch.js';

const context = { repositoryId: 'repo-1', bindingRevision: 2, primaryRemote: 'origin', directory: '/repo' };
const providerTarget = { project: 'platform/app', number: 42 };

function setup(routes = {}, { local = { sha: PS3, changeId: fixtures.changeId }, upstream = 'master' } = {}) {
  const gerrit = fakeGerrit(changeRoutes(routes));
  const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch: gerrit.fetch, delay: async () => {} });
  const service = createGerritResourceService({
    origin: ORIGIN,
    client,
    resolveProjects: resolvePlatformApp,
    readLocalRevision: async () => local,
    readUpstreamBranch: async () => upstream,
  });
  return { ...gerrit, service };
}

describe('Gerrit change status by Change-Id', () => {
  it('finds the open change on the tracked branch among cherry-picks, with its stack and uploaded patchset', async () => {
    const { service, calls } = setup({ 'GET /changes/': fixtures.statusQuery });

    const status = await service.changeRequestStatus('/repo', 'login', 'origin');

    const query = calls.find((call) => call.url.pathname === '/a/changes/');
    expect(query.url.searchParams.get('q')).toBe(`change:${fixtures.changeId} project:platform/app`);
    expect(status).toMatchObject({
      project: { id: 'platform/app', defaultBranch: 'master', remoteName: 'origin' },
      branch: 'login',
      changeRequest: { number: 42, base: 'master', headSha: PS3, head: 'refs/changes/42/42/3' },
      canMerge: false,
      localRevision: { sha: PS3, changeId: fixtures.changeId, uploadedAs: 3 },
      defaultBranch: 'master',
      resolvedRemoteName: 'origin',
    });
    expect(status.stack.layers.map((layer) => layer.number)).toEqual([41, 42, 43]);
  });

  it('picks the cherry-pick on the branch the local branch tracks', async () => {
    const { service } = setup({ 'GET /changes/': fixtures.statusQuery }, { local: { sha: fixtures.shas.pick, changeId: fixtures.changeId }, upstream: 'stable-1.0' });

    const status = await service.changeRequestStatus('/repo', 'pick', 'origin');

    expect(status.changeRequest).toMatchObject({ number: 57, base: 'stable-1.0' });
    expect(status.localRevision.uploadedAs).toBe(1);
  });

  it('reports local commits that are not uploaded yet', async () => {
    const { service } = setup({ 'GET /changes/': fixtures.statusQuery }, { local: { sha: 'e'.repeat(40), changeId: fixtures.changeId } });
    const status = await service.changeRequestStatus('/repo', 'login', 'origin');
    expect(status.localRevision).toEqual({ sha: 'e'.repeat(40), changeId: fixtures.changeId, uploadedAs: null });
  });

  it('answers no change without asking Gerrit when the tip has no Change-Id', async () => {
    const { service, calls } = setup({}, { local: { sha: PS3, changeId: null } });
    const status = await service.changeRequestStatus('/repo', 'login', 'origin');
    expect(status).toMatchObject({ changeRequest: null, localRevision: { sha: PS3, changeId: null, uploadedAs: null } });
    expect(calls.some((call) => call.url.pathname === '/a/changes/')).toBe(false);
  });

  it('keeps an abandoned change as history when nothing is open', async () => {
    const { service } = setup({ 'GET /changes/': [fixtures.statusQuery[2]] });
    const status = await service.changeRequestStatus('/repo', 'login', 'origin');
    expect(status.changeRequest).toMatchObject({ number: 30, state: 'closed' });
    expect(status).not.toHaveProperty('stack');
  });

  it('propagates a failed lookup instead of an empty status', async () => {
    const { service } = setup({ 'GET /changes/': () => new Response('boom', { status: 500 }) });
    await expect(service.changeRequestStatus('/repo', 'login', 'origin')).rejects.toMatchObject({ status: 500 });
  });

  it('selects by tracked branch, default branch, the only open one, the newest open one, then history', () => {
    const open = (number, branch, updated) => ({ _number: number, branch, status: 'NEW', updated });
    const closed = (number, updated) => ({ _number: number, branch: 'master', status: 'MERGED', updated });
    const pick = (candidates, upstreamBranch = null, defaultBranch = 'master') => selectChangeForBranch(candidates, { upstreamBranch, defaultBranch })?._number;
    const all = [open(1, 'a', '2026-01-02'), open(2, 'master', '2026-01-01'), open(3, 'b', '2026-01-03'), closed(4, '2026-01-04')];
    expect(pick(all, 'a')).toBe(1);
    expect(pick(all, 'zzz')).toBe(2);
    expect(pick([open(1, 'a', '2026-01-02'), closed(4, '2026-01-04')], null, 'none')).toBe(1);
    expect(pick([open(1, 'a', '2026-01-02'), open(3, 'b', '2026-01-03')], null, 'none')).toBe(3);
    expect(pick([closed(4, '2026-01-04'), closed(5, '2026-01-05')])).toBe(5);
    expect(pick([])).toBeUndefined();
  });
});

describe('Gerrit change list', () => {
  it('queries the bound project and pages by _more_changes', async () => {
    const { service, calls } = setup({
      'GET /changes/': (call) => (call.url.searchParams.get('S') === '20' ? [fixtures.statusQuery[0]] : [{ ...fixtures.statusQuery[1], _more_changes: true }]),
    });

    const first = await service.listChangeRequests('/repo', { page: 1, state: 'open', people: 'reviewRequested', query: 'login "form"', remote: 'origin' });
    const second = await service.listChangeRequests('/repo', { page: 2, state: 'merged', query: '42', remote: 'origin' });

    expect(first).toMatchObject({ page: 1, hasMore: true, items: [{ number: 42 }] });
    expect(second).toMatchObject({ page: 2, hasMore: false, items: [{ number: 57 }] });
    const queries = calls.filter((call) => call.url.pathname === '/a/changes/').map((call) => call.url.searchParams.get('q'));
    expect(queries).toEqual([
      'project:platform/app status:open reviewer:self -owner:self message:"login form"',
      'project:platform/app status:merged change:42',
    ]);
  });
});

describe('Gerrit change context', () => {
  it('reads votes, requirements, patchsets, messages, inline comments, files and the diff', async () => {
    const { service, calls } = setup();

    const result = await service.changeRequestContext('/repo', 42, { includeDiff: true, includeTimeline: true, remote: 'origin' });

    expect(calls.find((call) => call.url.pathname === `/a${CHANGE}`).url.searchParams.getAll('o')).toEqual([
      'ALL_REVISIONS', 'CURRENT_COMMIT', 'LABELS', 'DETAILED_LABELS', 'DETAILED_ACCOUNTS', 'MESSAGES', 'SUBMITTABLE', 'SUBMIT_REQUIREMENTS',
    ]);
    expect(result.changeRequest).toMatchObject({ number: 42, revisionNumber: 3, labels: [{ name: 'ui' }] });
    expect(result.voteLabels.map((label) => [label.name, label.status])).toEqual([['Code-Review', 'recommended'], ['Verified', 'approved']]);
    expect(result.submitRequirements).toEqual([{ name: 'Code-Review', status: 'unsatisfied' }]);
    expect(result.revisions.map((revision) => revision.number)).toEqual([1, 2, 3]);
    expect(result.issueComments.map((comment) => comment.revision)).toEqual([1, 2, 3, 3, 3]);
    expect(result.reviewComments).toEqual([expect.objectContaining({ path: 'src/login.js', line: 2, revision: 3, body: 'Nit: name this field.' })]);
    // The renamed file's patch is the addition of its new path: /patch has no rename detection.
    expect(result.files.map((file) => [file.path, file.status, Boolean(file.patch)])).toEqual([
      ['src/old.js', 'removed', true], ['docs/login.md', 'added', true], ['src/login.js', 'modified', true], ['src/session.js', 'renamed', true],
    ]);
    expect(result.diff.startsWith('diff --git a/docs/login.md')).toBe(true);
    expect(result.stack.layers).toHaveLength(3);
    expect(result.commits).toEqual([{ sha: PS3, headline: 'Add login form', authorName: 'alice', committedAt: '2026-10-22T17:52:13.000Z', url: `${ORIGIN}/c/platform/app/+/42` }]);
    expect(result.reviewers.map((user) => user.username)).toEqual(['bob', 'carol']);
    expect(result.ci).toBeNull();
    expect(result).not.toHaveProperty('verdicts');
  });

  it('reads the files of an older patchset when one is named, and refuses one the change does not have', async () => {
    const { service, calls } = setup({
      [`GET ${CHANGE}/revisions/${PS2}/files/`]: { 'src/login.js': { lines_inserted: 1 } },
      [`GET ${CHANGE}/revisions/${PS2}/patch`]: () => gerritBase64(fixtures.patch),
    });

    const result = await service.changeRequestContext('/repo', 42, { includeDiff: true, remote: 'origin', revision: PS2 });
    expect(result.files.map((file) => file.path)).toEqual(['src/login.js']);
    expect(calls.some((call) => call.url.pathname.endsWith(`/revisions/${PS3}/files/`))).toBe(false);
    // The header still names the current patchset; the files are the asked one's.
    expect(result.changeRequest.headSha).toBe(PS3);

    await expect(service.changeRequestContext('/repo', 42, { remote: 'origin', revision: 'd'.repeat(40) })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a selector outside the bound project and a change of another project', async () => {
    const { service } = setup({ 'GET /changes/platform%2Fapp~7': { ...fixtures.change, _number: 7, project: 'other/app' } });
    await expect(service.changeRequestContext('/repo', 42, { project: { owner: 'other', name: 'app' }, remote: 'origin' })).rejects.toMatchObject({ status: 404 });
    await expect(service.changeRequestContext('/repo', 7, { remote: 'origin' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('Gerrit patch and file reads', () => {
  it('answers the diff part of a patchset\'s patch', async () => {
    const { service } = setup();
    const result = await service.changeRequestPatch('/repo', 42, { remote: 'origin' });
    expect(result.meta).toEqual({ owner: 'platform', repo: 'app', number: 42 });
    expect(result.patch.startsWith('diff --git ')).toBe(true);
  });

  it('reads both sides of a file at a patchset, the earlier one from its parent', async () => {
    const { service, calls } = setup({
      [`GET ${CHANGE}/revisions/${PS3}/files/src%2Flogin.js/content`]: (call) => gerritBase64(call.url.searchParams.get('parent') === '1' ? fixtures.fileContent.parent : fixtures.fileContent.head),
      [`GET ${CHANGE}/revisions/${PS3}/files/%2FCOMMIT_MSG/content`]: () => gerritBase64(Buffer.from('Add login form\n').toString('base64')),
    });

    await expect(service.changeRequestFileContents('/repo', 42, { remote: 'origin', path: 'src/login.js', status: 'M' })).resolves.toEqual({
      original: 'export function login() {\n  return null;\n}\n',
      modified: 'export function login(form) {\n  validate(form);\n  return form;\n}\nconst validate = () => {};\n',
    });
    await expect(service.changeRequestFileContents('/repo', 42, { remote: 'origin', path: '/COMMIT_MSG' })).resolves.toEqual({ original: '', modified: 'Add login form\n' });
    expect(calls.filter((call) => call.url.pathname.endsWith('/content')).every((call) => call.url.pathname.includes(`/revisions/${PS3}/`))).toBe(true);
  });
});

describe('Gerrit live summaries and reviewer candidates', () => {
  it('summarizes known changes and leaves an unreadable one out', async () => {
    const { service } = setup({ 'GET /changes/platform%2Fapp~9': () => replay(fixtures.errors.notFound) });
    const result = await service.liveSummaries({ refs: [{ owner: 'platform', repo: 'app', number: 42 }, { owner: 'platform', repo: 'app', number: 9 }], issueRefs: [] });
    expect(result).toEqual({ summaries: [expect.objectContaining({ number: 42, state: 'open', mergeable: false })], issueSummaries: [] });
  });

  it('fails live summaries on a refused account', async () => {
    const { service } = setup({ [`GET ${CHANGE}`]: () => replay(fixtures.errors.unauthorized) });
    await expect(service.liveSummaries({ refs: [{ owner: 'platform', repo: 'app', number: 42 }] })).rejects.toMatchObject({ status: 401 });
  });

  it('derives reviewer candidates from recent changes', async () => {
    const { service } = setup({ 'GET /changes/': [fixtures.change, { ...fixtures.change, owner: fixtures.change.reviewers.REVIEWER[0] }] });
    await expect(service.listReviewerCandidates('/repo', { owner: 'platform', name: 'app' }, 'origin')).resolves.toEqual([
      { id: '1000096', login: 'alice' },
      { id: '1000097', login: 'bob' },
      { id: '1000098', login: 'carol' },
    ]);
  });

  it('lists branch heads only', async () => {
    const { service } = setup({ 'GET /projects/platform%2Fapp/branches/': fixtures.branches });
    await expect(service.projectBranches('/repo', { owner: 'platform', name: 'app' }, 'origin')).resolves.toEqual(['master', 'release-0.9', 'stable-1.0']);
  });
});

describe('Gerrit top-level projects', () => {
  it('reads a change of a project without an owner segment', async () => {
    const gerrit = fakeGerrit({
      'GET /projects/demo/HEAD': fixtures.projectHead,
      'GET /changes/demo~1': fixtures.topLevelChange,
    });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch: gerrit.fetch });
    const service = createGerritResourceService({
      origin: ORIGIN, client,
      resolveProjects: async () => ({ repos: [{ owner: '', name: 'demo', project: 'demo', repoPath: 'demo', remoteName: 'origin' }] }),
      readLocalRevision: async () => ({ sha: PS3, changeId: null }),
      readUpstreamBranch: async () => null,
    });

    await expect(service.changeRequestStatus('/repo', 'main', 'origin')).resolves.toMatchObject({ project: { id: 'demo', owner: '', name: 'demo' } });
    const found = await service.findChangeRequest('/repo', 1, { owner: '', name: 'demo' }, 'origin');
    expect(found.request).toMatchObject({ id: 'demo#1', project: { owner: '', name: 'demo' } });
    const live = await service.liveSummaries({ refs: [{ owner: '', repo: 'demo', number: 1 }] });
    expect(live.summaries).toEqual([expect.objectContaining({ owner: '', repo: 'demo', number: 1 })]);
    await expect(service.findChangeRequest('/repo', 1, { owner: 'x', name: 'demo' }, 'origin')).rejects.toMatchObject({ status: 404 });
  });
});

describe('Gerrit mutations', () => {
  it('resolves a change target and refuses one whose patchset moved', async () => {
    const { service } = setup();
    const expected = { project: { owner: 'platform', name: 'app' }, number: 42, headSha: PS3 };
    await expect(service.resolveChangeRequestMutation(context, expected)).resolves.toEqual({
      providerTarget,
      target: {
        repositoryId: 'repo-1', bindingRevision: 2, primaryRemote: 'origin', project: { id: 'platform/app', owner: 'platform', name: 'app' },
        number: 42, head: 'refs/changes/42/42/3', base: 'master', headSha: PS3,
      },
    });
    await expect(service.resolveChangeRequestMutation(context, { ...expected, headSha: PS2 })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH' });
  });

  it('posts votes to the patchset that was read, and refuses once a newer one is current', async () => {
    const { service, calls } = setup({ [`POST ${CHANGE}/revisions/${PS3}/review`]: fixtures.reviewResult });
    await expect(service.vote({ providerTarget, votes: { 'Code-Review': 2 }, body: 'LGTM', expectedTarget: { headSha: PS3 } })).resolves.toEqual({ commented: true });
    expect(calls.at(-1).body).toEqual({ labels: { 'Code-Review': 2 }, message: 'LGTM' });

    await expect(service.vote({ providerTarget, votes: { 'Code-Review': 2 }, expectedTarget: { headSha: PS2 } })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('accepts a review result with or without change_info (3.10 and 3.8)', async () => {
    const { service } = setup({ [`POST ${CHANGE}/revisions/${PS3}/review`]: fixtures.reviewResult_3_10 });
    await expect(service.vote({ providerTarget, votes: { 'Code-Review': 2 }, expectedTarget: { headSha: PS3 } })).resolves.toEqual({ commented: false });
  });

  it('submits only the current patchset and passes Gerrit\'s refusal through', async () => {
    const { service } = setup({ [`POST ${CHANGE}/submit`]: () => replay(fixtures.errors.submitBlocked) });
    await expect(service.submit({ providerTarget, expectedTarget: { headSha: PS3 } })).rejects.toMatchObject({ status: 409, message: fixtures.errors.submitBlocked.body.trim() });
    await expect(service.submit({ providerTarget, expectedTarget: { headSha: PS2 } })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH' });
  });

  it('refuses a submit that names no patchset, without posting it', async () => {
    const { service, calls } = setup({ [`POST ${CHANGE}/submit`]: { ...fixtures.change, status: 'MERGED' } });
    await expect(service.submit({ providerTarget, expectedTarget: {} })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH' });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('sends the reviewer difference, additions then removals', async () => {
    const { service, calls } = setup({
      [`POST ${CHANGE}/reviewers`]: fixtures.reviewerAdded,
      [`POST ${CHANGE}/reviewers/1000097/delete`]: new Response(null, { status: 204 }),
    });
    await service.setReviewers({ providerTarget, reviewers: ['1000098', '1000099'] });
    expect(calls.filter((call) => call.method === 'POST').map((call) => [call.url.pathname, call.body])).toEqual([
      [`/a${CHANGE}/reviewers`, { reviewer: '1000099' }],
      [`/a${CHANGE}/reviewers/1000097/delete`, {}],
    ]);
  });

  it('refuses a reviewer Gerrit could not add', async () => {
    // 3.8 answers the refusal with a 200 ReviewerResult, 3.10 with a 400 one.
    for (const answer of [fixtures.reviewerRefused, () => replay(fixtures.errors.reviewerRefused)]) {
      const { service } = setup({ [`POST ${CHANGE}/reviewers`]: answer });
      await expect(service.setReviewers({ providerTarget, reviewers: ['999', '1000097', '1000098'] })).rejects.toMatchObject({ status: 400, message: fixtures.reviewerRefused.error });
    }
  });

  it('abandons and restores, and reconciles by the change status', async () => {
    let status = 'NEW';
    const { service } = setup({
      [`POST ${CHANGE}/abandon`]: () => { status = 'ABANDONED'; return { ...fixtures.change, status }; },
      [`GET ${CHANGE}`]: () => ({ ...fixtures.change, status }),
    });
    await expect(service.setState({ providerTarget, state: 'closed' })).resolves.toEqual({ state: 'closed' });
    await expect(service.reconcileStateMutation(providerTarget, 'closed')).resolves.toMatchObject({ state: 'succeeded' });
    await expect(service.reconcileStateMutation(providerTarget, 'open')).resolves.toMatchObject({ state: 'failed' });
  });

  it('reconciles submit by MERGED and ready by the work-in-progress flag', async () => {
    let raw = { ...fixtures.change, status: 'MERGED' };
    const { service } = setup({ [`GET ${CHANGE}`]: () => raw });
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-merge')).resolves.toEqual({ state: 'succeeded', result: { merged: true } });
    raw = { ...fixtures.change, work_in_progress: true };
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-merge')).resolves.toMatchObject({ state: 'failed' });
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-ready')).resolves.toMatchObject({ state: 'failed' });
    raw = { ...fixtures.change };
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-ready')).resolves.toMatchObject({ state: 'succeeded' });
  });
});
