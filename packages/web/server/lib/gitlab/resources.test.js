import { describe, expect, it, vi } from 'vitest';
import { createGitLabResourceService } from './resources.js';

const origin = 'https://gitlab.example.com';
const sourceProject = {
  id: 1, path_with_namespace: 'me/repo', web_url: `${origin}/me/repo`, default_branch: 'main',
  forked_from_project: { id: 2 },
};
const targetProject = { id: 2, path_with_namespace: 'team/repo', web_url: `${origin}/team/repo`, default_branch: 'main' };
const openMR = {
  id: 100, iid: 5, title: 'Feature', web_url: `${origin}/team/repo/-/merge_requests/5`, state: 'opened',
  source_branch: 'feature', target_branch: 'main', source_project_id: 1, target_project_id: 2,
  head_pipeline: { id: 9, status: 'running' }, detailed_merge_status: 'mergeable', draft: false,
};

function setup(overrides = {}, options = {}) {
  const client = {
    Projects: { show: vi.fn(async (id) => Number(id) === 2 ? targetProject : sourceProject) },
    MergeRequests: {
      all: vi.fn(async () => [openMR]),
      show: vi.fn(async () => openMR),
      create: vi.fn(async () => openMR),
      edit: vi.fn(async (_id, _iid, options) => ({ ...openMR, draft: options.draft ?? false, title: options.title ?? openMR.title })),
      merge: vi.fn(async () => ({ ...openMR, state: 'merged' })),
      allDiffs: vi.fn(async () => [{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@' }]),
    },
    MergeRequestNotes: { all: vi.fn(async () => [{ id: 4, body: 'Looks good', author: { id: 3, username: 'sam' } }]) },
    Jobs: { all: vi.fn(async () => [{ id: 8, name: 'test', status: 'running' }]) },
    Issues: {
      all: vi.fn(async () => [{ iid: 3, title: 'Bug', web_url: `${origin}/me/repo/-/issues/3`, state: 'opened' }]),
      show: vi.fn(async () => ({ iid: 3, title: 'Bug', web_url: `${origin}/me/repo/-/issues/3`, state: 'opened' })),
    },
    IssueNotes: { all: vi.fn(async () => [{ id: 6, body: 'Comment' }]) },
    Branches: { all: vi.fn(async () => [{ name: 'main' }, { name: 'feature' }]) },
    ...overrides,
  };
  const resolveProjects = vi.fn(async () => ({
    branch: 'feature', tracking: 'origin/feature',
    projects: [{ projectPath: 'me/repo', remoteName: 'origin', url: `${origin}/me/repo` }],
  }));
  return { client, resolveProjects, service: createGitLabResourceService({ origin, client, resolveProjects, ...options }) };
}

describe('GitLab resource service', () => {
  it('finds a fork merge request in its upstream and keeps CI separate', async () => {
    const { service, client } = setup();
    const result = await service.changeRequestStatus('/repo', 'feature');
    expect(result).toMatchObject({
      project: { id: '2', owner: 'team', name: 'repo' },
      changeRequest: { number: 5, state: 'open', head: 'feature' },
      ci: { summary: { state: 'pending', total: 0 } },
      resolvedRemoteName: 'origin',
    });
    expect(client.MergeRequests.all).toHaveBeenCalledWith(expect.objectContaining({ projectId: '2', state: 'opened', sourceBranch: 'feature' }));
  });

  it('returns authoritative null only after completed lookups', async () => {
    const { service } = setup({ MergeRequests: { ...setup().client.MergeRequests, all: vi.fn(async () => []) } });
    await expect(service.changeRequestStatus('/repo', 'feature')).resolves.toMatchObject({ changeRequest: null, project: { id: '1' } });
  });

  it('propagates lookup failure instead of returning empty status', async () => {
    const failure = new Error('GitLab unavailable');
    const { service } = setup({ MergeRequests: { ...setup().client.MergeRequests, all: vi.fn(async () => { throw failure; }) } });
    await expect(service.changeRequestStatus('/repo', 'feature')).rejects.toBe(failure);
  });

  it.each([
    ['status top-level list', 'status', { items: [] }],
    ['status list item', 'status', [{ ...openMR, title: '' }]],
    ['status project identity', 'status', [{ ...openMR, source_project_id: null }]],
    ['status author', 'status', [{ ...openMR, author: { id: 3 } }]],
    ['picker top-level list', 'list', { items: [] }],
    ['picker list item', 'list', [{ ...openMR, web_url: null }]],
  ])('rejects malformed canonical merge-request %s', async (_label, operation, payload) => {
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, all: vi.fn(async () => payload) },
    }, { canonicalReads: true });
    const result = operation === 'status'
      ? service.changeRequestStatus('/repo', 'feature', 'origin')
      : service.listChangeRequests('/repo', { remote: 'origin' });
    await expect(result).rejects.toThrow('invalid merge request');
  });

  it('keeps merge-request context when CI jobs fail', async () => {
    const { service } = setup({ Jobs: { all: vi.fn(async () => { throw new Error('jobs unavailable'); }) } });
    const result = await service.changeRequestContext('/repo', 5, { includeDiff: true, includeCIDetails: true });
    expect(result).toMatchObject({ changeRequest: { number: 5 }, files: [{ path: 'a.ts' }], issueComments: [{ body: 'Looks good' }], ci: null });
  });

  it.each([
    { jobs: [] },
    [{ id: 8, status: 'running' }],
  ])('returns null CI for malformed detailed job payload %s', async (jobs) => {
    const { service } = setup({ Jobs: { all: vi.fn(async () => jobs) } }, { canonicalReads: true });
    const result = await service.changeRequestContext('/repo', 5, { includeCIDetails: true });
    expect(result.ci).toBeNull();
  });

  it.each([
    { id: 9 },
    { id: '9', status: 'running' },
  ])('returns null CI for malformed pipeline payload %s', async (pipeline) => {
    const malformedMR = { ...openMR, head_pipeline: pipeline };
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => malformedMR) },
    }, { canonicalReads: true });
    const result = await service.changeRequestContext('/repo', 5, { includeCIDetails: true });
    expect(result.ci).toBeNull();
  });

  it.each([
    ['top-level note list', { notes: [] }, []],
    ['note item', [{ id: 4 }], []],
    ['note author', [{ id: 4, body: 'Comment', author: { id: 3 } }], []],
    ['note position', [{ id: 4, body: 'Comment', position: {} }], []],
    ['top-level diff list', [], { diffs: [] }],
    ['diff item', [], [{ diff: '@@' }]],
  ])('rejects malformed canonical merge-request context %s', async (_label, notes, diffs) => {
    const { service } = setup({
      MergeRequestNotes: { all: vi.fn(async () => notes) },
      MergeRequests: { ...setup().client.MergeRequests, allDiffs: vi.fn(async () => diffs) },
    }, { canonicalReads: true });
    await expect(service.changeRequestContext('/repo', 5, { includeDiff: true }))
      .rejects.toThrow(/invalid merge request (note|diff)/);
  });

  it('keeps malformed legacy merge-request collections best-effort', async () => {
    const { service } = setup({
      MergeRequests: {
        ...setup().client.MergeRequests,
        all: vi.fn(async () => ({ items: [] })),
        allDiffs: vi.fn(async () => ({ diffs: [] })),
      },
      MergeRequestNotes: { all: vi.fn(async () => ({ notes: [] })) },
    });

    await expect(service.changeRequestStatus('/repo', 'feature')).resolves.toMatchObject({ changeRequest: null });
    await expect(service.listChangeRequests('/repo')).resolves.toMatchObject({ items: [] });
    await expect(service.changeRequestContext('/repo', 5, { includeDiff: true }))
      .resolves.toMatchObject({ issueComments: [], reviewComments: [], files: [] });
  });

  it.each(['status', 'list', 'context'])('propagates canonical merge-request fork-parent failure for %s', async (operation) => {
    const failure = Object.assign(new Error('upstream unavailable'), { status: 503 });
    const { service } = setup({
      Projects: { show: vi.fn(async (id) => Number(id) === 2 ? Promise.reject(failure) : sourceProject) },
    }, { canonicalReads: true });
    const result = operation === 'status'
      ? service.changeRequestStatus('/repo', 'feature', 'origin')
      : operation === 'list'
        ? service.listChangeRequests('/repo', { remote: 'origin' })
        : service.changeRequestContext('/repo', 5, { remote: 'origin', constrainToPrimary: true });
    await expect(result).rejects.toBe(failure);
  });

  it('starts canonical pull reads from the primary remote and constrains project selectors', async () => {
    const { service, client, resolveProjects } = setup();

    await expect(service.listChangeRequests('/repo', { remote: 'upstream' })).resolves.toMatchObject({ items: [{ number: 5 }] });
    await expect(service.changeRequestContext('/repo', 5, {
      remote: 'upstream',
      constrainToPrimary: true,
      project: { owner: 'team', name: 'repo' },
    })).resolves.toMatchObject({ changeRequest: { number: 5 } });
    await expect(service.changeRequestContext('/repo', 5, {
      remote: 'upstream',
      constrainToPrimary: true,
      project: { owner: 'other', name: 'secret' },
    })).rejects.toMatchObject({ status: 404 });

    expect(resolveProjects).toHaveBeenCalledWith('/repo', origin, 'upstream');
    expect(client.Projects.show).not.toHaveBeenCalledWith('other/secret');
  });

  it('starts issue and repository reads from the primary remote and constrains selectors', async () => {
    const { service, client, resolveProjects } = setup();

    await expect(service.listIssues('/repo', { remote: 'upstream' })).resolves.toMatchObject({ items: [{ number: 3 }] });
    await expect(service.getIssue('/repo', 3, { owner: 'team', name: 'repo' }, 'upstream')).resolves.toMatchObject({ number: 3 });
    await expect(service.issueComments('/repo', 3, { owner: 'team', name: 'repo' }, 'upstream')).resolves.toMatchObject([{ body: 'Comment' }]);
    await expect(service.projectUpstream('/repo', 'upstream')).resolves.toMatchObject({ isFork: true, upstream: { id: '2' } });
    await expect(service.projectBranches('/repo', { owner: 'team', name: 'repo' }, 'upstream')).resolves.toEqual(['main', 'feature']);
    await expect(service.getIssue('/repo', 3, { owner: 'other', name: 'secret' }, 'upstream')).rejects.toMatchObject({ status: 404 });
    await expect(service.projectBranches('/repo', { owner: 'other', name: 'secret' }, 'upstream')).rejects.toMatchObject({ status: 404 });

    expect(resolveProjects).toHaveBeenCalledWith('/repo', origin, 'upstream');
    expect(client.Projects.show).not.toHaveBeenCalledWith('other/secret');
  });

  it('propagates branch fork-network resolution failures', async () => {
    const failure = Object.assign(new Error('upstream unavailable'), { status: 503 });
    const { service, client } = setup({
      Projects: { show: vi.fn(async (id) => Number(id) === 2 ? Promise.reject(failure) : sourceProject) },
    });

    await expect(service.projectBranches('/repo', { owner: 'me', name: 'repo' }, 'origin')).rejects.toBe(failure);
    expect(client.Branches.all).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error('forbidden'), { status: 403 }),
    Object.assign(new Error('missing'), { status: 404 }),
    Object.assign(new Error('unavailable'), { status: 503 }),
    Object.assign(new Error('offline'), { code: 'ENOTFOUND' }),
  ])('propagates issue fork-parent resolution failure: %s', async (failure) => {
    const { service, client } = setup({
      Projects: { show: vi.fn(async (id) => Number(id) === 2 ? Promise.reject(failure) : sourceProject) },
    });

    await expect(service.getIssue('/repo', 3, { owner: 'team', name: 'repo' }, 'origin')).rejects.toBe(failure);
    await expect(service.issueComments('/repo', 3, { owner: 'team', name: 'repo' }, 'origin')).rejects.toBe(failure);
    expect(client.Issues.show).not.toHaveBeenCalled();
  });

  it('rejects malformed canonical issue and branch payloads', async () => {
    const malformedIssue = setup({
      Issues: { ...setup().client.Issues, all: vi.fn(async () => [{ iid: 3, state: 'opened' }]) },
    }, { canonicalReads: true });
    await expect(malformedIssue.service.listIssues('/repo', { remote: 'origin' })).rejects.toThrow('invalid issue');

    const malformedIssueList = setup({
      Issues: { ...setup().client.Issues, all: vi.fn(async () => ({ items: [] })) },
    }, { canonicalReads: true });
    await expect(malformedIssueList.service.listIssues('/repo', { remote: 'origin' })).rejects.toThrow('invalid issue list');

    const malformedIssueDetail = setup({
      Issues: { ...setup().client.Issues, show: vi.fn(async () => ({ iid: 3, state: 'opened' })) },
    }, { canonicalReads: true });
    await expect(malformedIssueDetail.service.getIssue('/repo', 3, undefined, 'origin')).rejects.toThrow('invalid issue');
    await expect(malformedIssueDetail.service.issueComments('/repo', 3, undefined, 'origin')).rejects.toThrow('invalid issue');

    const malformedBranches = setup({
      Branches: { all: vi.fn(async () => [{ name: 'main' }, {}]) },
    }, { canonicalReads: true });
    await expect(malformedBranches.service.projectBranches('/repo', { owner: 'me', name: 'repo' }, 'origin')).rejects.toThrow('invalid branch');
  });

  it.each([
    ['author', { author: { id: 7 } }],
    ['negative author ID', { author: { id: -1, username: 'alex' } }],
    ['assignee', { assignees: [{ username: 'alex' }] }],
    ['label', { labels: ['valid', { color: '#fff' }] }],
  ])('rejects malformed nested canonical issue %s data', async (_label, nested) => {
    const issue = { iid: 3, title: 'Bug', web_url: `${origin}/me/repo/-/issues/3`, state: 'opened', ...nested };
    const malformed = setup({
      Issues: { ...setup().client.Issues, all: vi.fn(async () => [issue]), show: vi.fn(async () => issue) },
    }, { canonicalReads: true });

    await expect(malformed.service.listIssues('/repo', { remote: 'origin' })).rejects.toThrow('invalid issue');
    await expect(malformed.service.getIssue('/repo', 3, undefined, 'origin')).rejects.toThrow('invalid issue');
  });

  it.each([
    { notes: [] },
    [{ id: 6 }],
    [{ id: 6, body: 'Comment', author: { id: 7 } }],
    [{ id: 6, body: 'Comment', author: { id: -1, username: 'alex' } }],
  ])('rejects malformed canonical issue-note payload %s', async (notes) => {
    const malformedNotes = setup({ IssueNotes: { all: vi.fn(async () => notes) } }, { canonicalReads: true });
    await expect(malformedNotes.service.issueComments('/repo', 3, undefined, 'origin')).rejects.toThrow('invalid issue note');
  });

  it.each([
    { id: '2' },
    { name: 'missing id' },
  ])('rejects malformed canonical fork metadata %s', async (forkedFromProject) => {
    const malformedSource = { ...sourceProject, forked_from_project: forkedFromProject };
    const malformedFork = setup({
      Projects: { show: vi.fn(async () => malformedSource) },
    }, { canonicalReads: true });
    await expect(malformedFork.service.projectUpstream('/repo', 'origin')).rejects.toThrow('invalid fork metadata');
  });

  it('supports squash merge and rejects a non-atomic rebase merge', async () => {
    const { service, client } = setup();
    await expect(service.mergeChangeRequest({ directory: '/repo', number: 5, method: 'squash' })).resolves.toEqual({ merged: true, message: undefined });
    expect(client.MergeRequests.merge).toHaveBeenCalledWith('1', 5, { squash: true });
    await expect(service.mergeChangeRequest({ directory: '/repo', number: 5, method: 'rebase' })).rejects.toThrow('atomic merge method');
  });

  it('resolves canonical create mutations only through the primary project and declared parent', async () => {
    const { service, resolveProjects } = setup({}, { canonicalReads: true });
    const context = { directory: '/repo', repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin' };
    const result = await service.resolveCreateMutation(context, {
      project: { owner: 'team', name: 'repo' }, head: 'feature', base: 'main',
    }, {});

    expect(result).toEqual({
      providerTarget: { sourceProjectId: '1', targetProjectId: '2' },
      target: {
        repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: '2', owner: 'team', name: 'repo' }, head: 'feature', base: 'main',
      },
    });
    expect(resolveProjects).toHaveBeenCalledWith('/repo', origin, 'origin', { exactRemote: true });
  });

  it('rejects arbitrary create projects and remote topology changes before mutation', async () => {
    const { service, client, resolveProjects } = setup({}, { canonicalReads: true });
    const context = { directory: '/repo', repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin' };
    const expected = { project: { owner: 'other', name: 'secret' }, head: 'feature', base: 'main' };

    await expect(service.resolveCreateMutation(context, expected, {})).rejects.toMatchObject({ status: 404 });
    expect(client.Projects.show).not.toHaveBeenCalledWith('other/secret');
    await expect(service.resolveCreateMutation(context, expected, { remote: 'upstream' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH' });
    resolveProjects.mockImplementation(async (_directory, _origin, remote) => ({
      branch: 'feature', tracking: '',
      projects: [{ projectPath: remote === 'fork' ? 'other/secret' : 'me/repo', remoteName: remote }],
    }));
    client.Projects.show.mockImplementation(async (id) => id === 'other/secret'
      ? { id: 3, path_with_namespace: 'other/secret', web_url: `${origin}/other/secret` }
      : Number(id) === 2 ? targetProject : sourceProject);
    await expect(service.resolveCreateMutation(context, {
      project: { owner: 'team', name: 'repo' }, head: 'feature', base: 'main',
    }, { headRemote: 'fork' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH' });
    expect(client.MergeRequests.create).not.toHaveBeenCalled();
  });

  it('preflights canonical existing mutations against mapped target state', async () => {
    const request = { ...openMR, sha: 'abc123' };
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => request) },
    }, { canonicalReads: true });
    const context = { directory: '/repo', repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin' };
    const expected = {
      project: { owner: 'team', name: 'repo' }, number: 5, head: 'feature', base: 'main', headSha: 'abc123',
    };

    await expect(service.resolveChangeRequestMutation(context, expected)).resolves.toEqual({
      providerTarget: { projectId: '2', number: 5 },
      request: expect.objectContaining({ number: 5, head: 'feature', base: 'main', headSha: 'abc123' }),
      target: {
        repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: '2', owner: 'team', name: 'repo' },
        number: 5, head: 'feature', base: 'main', headSha: 'abc123',
      },
    });
    await expect(service.resolveChangeRequestMutation(context, { ...expected, headSha: 'stale' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409 });
  });

  it.each([
    ['missing', { draft: undefined, work_in_progress: undefined }],
    ['malformed', { draft: 'false', work_in_progress: null }],
  ])('rejects %s draft state during ready preflight', async (_label, draftFields) => {
    const request = { ...openMR, ...draftFields };
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => request) },
    }, { canonicalReads: true });
    const context = { directory: '/repo', repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin' };

    await expect(service.resolveChangeRequestMutation(context, {
      project: { owner: 'team', name: 'repo' }, number: 5, head: 'feature', base: 'main',
    })).rejects.toThrow('invalid merge request draft state');
  });

  it('creates a draft merge request through the GitLab title prefix', async () => {
    const { service, client } = setup({}, { canonicalReads: true });
    await service.createChangeRequest({
      providerTarget: { sourceProjectId: '1', targetProjectId: '2' },
      targetProject: { id: '2', owner: 'team', name: 'repo' },
      expectedTarget: { project: { id: '2', owner: 'team', name: 'repo' }, head: 'feature', base: 'main' },
      head: 'feature', base: 'main', title: 'Feature', body: 'Body', draft: true,
    });
    expect(client.MergeRequests.create).toHaveBeenCalledWith('1', 'feature', 'main', 'Draft: Feature', { description: 'Body', targetProjectId: '2' });
    await service.createChangeRequest({
      providerTarget: { sourceProjectId: '1', targetProjectId: '2' },
      targetProject: { id: '2', owner: 'team', name: 'repo' },
      expectedTarget: { project: { id: '2', owner: 'team', name: 'repo' }, head: 'feature', base: 'main' },
      head: 'feature', base: 'main', title: 'Feature', draft: false,
    });
    expect(client.MergeRequests.create).toHaveBeenLastCalledWith('1', 'feature', 'main', 'Feature', { description: undefined, targetProjectId: '2' });
  });

  it('marks a draft merge request ready by removing the title prefix', async () => {
    const draft = { ...openMR, draft: true, title: 'Draft: Feature' };
    const mergeRequests = {
      ...setup().client.MergeRequests,
      show: vi.fn(async () => draft),
      edit: vi.fn(async (_id, _iid, options) => ({ ...openMR, draft: false, title: options.title })),
    };
    const { service, client } = setup({ MergeRequests: mergeRequests }, { canonicalReads: true });
    await expect(service.readyChangeRequest({
      providerTarget: { projectId: '2', number: 5 },
      targetProject: { id: '2', owner: 'team', name: 'repo' },
      expectedTarget: { project: { id: '2', owner: 'team', name: 'repo' }, number: 5, head: 'feature', base: 'main' },
    })).resolves.toEqual({ ready: true });
    expect(client.MergeRequests.edit).toHaveBeenCalledWith('2', 5, { title: 'Feature' });
  });

  it('treats ready on a non-draft merge request as already applied without editing', async () => {
    const { service, client } = setup({}, { canonicalReads: true });
    await expect(service.readyChangeRequest({
      providerTarget: { projectId: '2', number: 5 },
      targetProject: { id: '2', owner: 'team', name: 'repo' },
      expectedTarget: { project: { id: '2', owner: 'team', name: 'repo' }, number: 5, head: 'feature', base: 'main' },
    })).resolves.toEqual({ ready: true });
    expect(client.MergeRequests.edit).not.toHaveBeenCalled();
  });

  it('rejects a malformed ready mutation response', async () => {
    const malformed = { ...openMR, draft: undefined, work_in_progress: undefined };
    const { service } = setup({
      MergeRequests: {
        ...setup().client.MergeRequests,
        show: vi.fn(async () => ({ ...openMR, draft: true, title: 'Draft: Feature' })),
        edit: vi.fn(async () => malformed),
      },
    }, { canonicalReads: true });

    await expect(service.readyChangeRequest({
      providerTarget: { projectId: '2', number: 5 },
      targetProject: { id: '2', owner: 'team', name: 'repo' },
      expectedTarget: { project: { id: '2', owner: 'team', name: 'repo' }, number: 5, head: 'feature', base: 'main' },
    })).rejects.toThrow('invalid merge request draft state');
  });

  it('rejects merge requests whose source project is outside the allowed network', async () => {
    const outside = { ...openMR, source_project_id: 99 };
    const { service, client } = setup({
      MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => outside) },
    }, { canonicalReads: true });
    const context = { directory: '/repo', repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin' };

    await expect(service.resolveChangeRequestMutation(context, {
      project: { owner: 'team', name: 'repo' }, number: 5,
    })).rejects.toThrow('outside the bound repository network');
    expect(client.MergeRequests.edit).not.toHaveBeenCalled();
    expect(client.MergeRequests.merge).not.toHaveBeenCalled();
  });

  it('reconciles create only from one exact provider match', async () => {
    const exact = { ...openMR, target_branch: 'main' };
    const mergeRequests = { ...setup().client.MergeRequests, all: vi.fn(async () => [exact]) };
    const { service } = setup({ MergeRequests: mergeRequests }, { canonicalReads: true });
    const providerTarget = { sourceProjectId: '1', targetProjectId: '2' };
    const target = { project: { id: '2', owner: 'team', name: 'repo' }, head: 'feature', base: 'main' };

    await expect(service.reconcileCreateMutation(providerTarget, target))
      .resolves.toEqual({ state: 'succeeded', result: {} });
    mergeRequests.all.mockResolvedValue([exact, { ...exact, iid: 6, web_url: `${origin}/team/repo/-/merge_requests/6` }]);
    await expect(service.reconcileCreateMutation(providerTarget, target))
      .resolves.toEqual({ state: 'outcome-unknown' });
  });

  it('reconciles existing mutations by reading authoritative provider state', async () => {
    const mergeRequests = { ...setup().client.MergeRequests, show: vi.fn(async () => ({ ...openMR, state: 'merged' })) };
    const { service } = setup({ MergeRequests: mergeRequests }, { canonicalReads: true });
    const providerTarget = { projectId: '2', number: 5 };
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-merge'))
      .resolves.toEqual({ state: 'succeeded', result: { merged: true } });

    mergeRequests.show.mockResolvedValue({ ...openMR, draft: false });
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-ready'))
      .resolves.toEqual({ state: 'succeeded', result: { ready: true } });
    await expect(service.reconcileChangeRequestMutation(providerTarget, 'change-request-update'))
      .resolves.toEqual({ state: 'outcome-unknown' });
    expect(mergeRequests.show).toHaveBeenCalledTimes(3);
  });

  it('keeps ready reconciliation unknown when provider draft state is malformed', async () => {
    const malformed = { ...openMR, draft: undefined, work_in_progress: 'false' };
    const mergeRequests = { ...setup().client.MergeRequests, show: vi.fn(async () => malformed) };
    const { service } = setup({ MergeRequests: mergeRequests }, { canonicalReads: true });

    await expect(service.reconcileChangeRequestMutation(
      { projectId: '2', number: 5 }, 'change-request-ready',
    )).rejects.toThrow('invalid merge request draft state');
  });

  it('maps paged issues, comments, upstream, and branches', async () => {
    const { service, client } = setup();
    await expect(service.listChangeRequests('/repo')).resolves.toMatchObject({ items: [{ number: 5 }], hasMore: false });
    expect(client.MergeRequests.all).toHaveBeenCalledWith(expect.objectContaining({ state: 'opened' }));
    await expect(service.listIssues('/repo')).resolves.toMatchObject({ items: [{ number: 3 }], hasMore: false });
    expect(client.Issues.all).toHaveBeenCalledWith(expect.objectContaining({ state: 'opened' }));
    await expect(service.issueComments('/repo', 3)).resolves.toMatchObject([{ body: 'Comment' }]);
    await expect(service.projectUpstream('/repo')).resolves.toMatchObject({ isFork: true, upstream: { id: '2' } });
    await expect(service.projectBranches('/repo', { owner: 'team', name: 'repo' })).resolves.toEqual(['main', 'feature']);
  });
});
