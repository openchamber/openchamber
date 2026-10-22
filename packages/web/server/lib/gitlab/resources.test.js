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

const list = (items, next = null) => vi.fn(async (...args) => (args.at(-1)?.showExpanded
  ? { data: items, paginationInfo: { next } }
  : items));

function setup(overrides = {}, options = {}) {
  const client = {
    Projects: { show: vi.fn(async (id) => Number(id) === 2 ? targetProject : sourceProject) },
    MergeRequests: {
      all: list([openMR]),
      show: vi.fn(async () => openMR),
      create: vi.fn(async () => openMR),
      edit: vi.fn(async (_id, _iid, options) => ({ ...openMR, draft: options.draft ?? false, title: options.title ?? openMR.title })),
      merge: vi.fn(async () => ({ ...openMR, state: 'merged' })),
      allDiffs: list([{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@' }]),
    },
    MergeRequestNotes: { all: list([{ id: 4, body: 'Looks good', author: { id: 3, username: 'sam' } }]) },
    Jobs: { all: vi.fn(async () => [{ id: 8, name: 'test', status: 'running' }]) },
    Issues: {
      all: list([{ iid: 3, title: 'Bug', web_url: `${origin}/me/repo/-/issues/3`, state: 'opened' }]),
      show: vi.fn(async () => ({ iid: 3, title: 'Bug', web_url: `${origin}/me/repo/-/issues/3`, state: 'opened' })),
    },
    IssueNotes: { all: list([{ id: 6, body: 'Comment' }]) },
    Branches: { all: list([{ name: 'main' }, { name: 'feature' }]) },
    ...overrides,
  };
  const resolveProjects = vi.fn(async () => ({
    branch: 'feature', tracking: 'origin/feature',
    projects: [{ projectPath: 'me/repo', remoteName: 'origin', url: `${origin}/me/repo` }],
  }));
  return { client, resolveProjects, service: createGitLabResourceService({ origin, client, resolveProjects, ...options }) };
}

describe('GitLab resource service', () => {
  it('reads an upload from a project in the bound network only', async () => {
    const download = vi.fn(async () => new Response('clip'));
    const { service } = setup({}, { download });
    const upload = { secret: '66dbcd21ec5d24ed6ea225176098d52b', filename: 'demo clip.mp4', range: 'bytes=0-' };

    await service.readUpload('/repo', { owner: 'team', name: 'repo' }, 'origin', upload);
    expect(download).toHaveBeenCalledWith('projects/2/uploads/66dbcd21ec5d24ed6ea225176098d52b/demo%20clip.mp4', { range: 'bytes=0-', signal: undefined });

    await expect(service.readUpload('/repo', { owner: 'other', name: 'secret' }, 'origin', upload)).rejects.toMatchObject({ status: 404 });
    expect(download).toHaveBeenCalledOnce();
  });

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
    const { service } = setup({ MergeRequests: { ...setup().client.MergeRequests, all: list([]) } });
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
      MergeRequests: { ...setup().client.MergeRequests, all: list(payload) },
    }, { canonicalReads: true });
    const result = operation === 'status'
      ? service.changeRequestStatus('/repo', 'feature', 'origin')
      : service.listChangeRequests('/repo', { remote: 'origin' });
    await expect(result).rejects.toThrow('invalid merge request');
  });

  it('lists by state and by whose items, reading the user once for review requests', async () => {
    const all = list([openMR]);
    const showCurrentUser = vi.fn(async () => ({ id: 3, username: 'sam' }));
    const issuesAll = list([]);
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, all },
      Users: { showCurrentUser },
      Issues: { ...setup().client.Issues, all: issuesAll },
    });
    await service.listChangeRequests('/repo', { state: 'merged', people: 'created' });
    expect(all.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'merged', scope: 'created_by_me' });
    await service.listChangeRequests('/repo', { state: 'all', people: 'reviewRequested' });
    await service.listChangeRequests('/repo', { people: 'reviewRequested' });
    expect(all.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'opened', scope: 'all', reviewerUsername: 'sam' });
    expect(showCurrentUser).toHaveBeenCalledTimes(1);
    await service.listIssues('/repo', { state: 'merged', people: 'assigned' });
    expect(issuesAll.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'closed', scope: 'assigned_to_me' });
  });

  it('adds commits and review verdicts only when the timeline asks', async () => {
    const commits = [
      { id: 'bbb', title: 'second', author_name: 'Sam', committed_date: '2026-10-02T10:00:00Z', web_url: `${origin}/team/repo/-/commit/bbb` },
      { id: 'aaa', title: 'first', author_name: 'Sam', committed_date: '2026-10-01T10:00:00Z', web_url: `${origin}/team/repo/-/commit/aaa` },
    ];
    const notes = [
      { id: 4, body: 'Looks good', author: { id: 3, username: 'sam' } },
      { id: 5, body: 'approved this merge request', system: true, created_at: '2026-10-02T11:00:00Z', author: { id: 3, username: 'sam' } },
      { id: 6, body: 'added 1 commit', system: true, author: { id: 3, username: 'sam' } },
    ];
    const allCommits = list(commits);
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, allCommits, show: vi.fn(async () => ({ ...openMR, reviewers: [{ id: 7, username: 'ann' }, { username: 'no-id' }] })) },
      MergeRequestNotes: { all: list(notes) },
      // The timeline reads the same notes as their discussions.
      MergeRequestDiscussions: { all: list(notes.map((note) => ({ id: `d${note.id}`, individual_note: true, notes: [note] }))) },
    });
    const plain = await service.changeRequestContext('/repo', 5, {});
    expect(plain).not.toHaveProperty('commits');
    expect(allCommits).not.toHaveBeenCalled();

    const result = await service.changeRequestContext('/repo', 5, { includeTimeline: true });
    expect(result.commits.map((commit) => commit.headline)).toEqual(['first', 'second']);
    expect(result.commitsComplete).toBe(true);
    expect(result.verdicts).toMatchObject([{ state: 'approved', createdAt: '2026-10-02T11:00:00Z', author: { username: 'sam' } }]);
    expect(result.issueComments.map((comment) => comment.body)).toEqual(['Looks good']);
    expect(result.reviewers).toEqual([expect.objectContaining({ id: '7', username: 'ann' })]);
  });

  it('reads the chain of open merge requests stacked by branch around this one, as far as each link is the only one', async () => {
    const mergeRequest = (iid, source, target, sourceProject = 2) => ({
      ...openMR, id: 100 + iid, iid, title: `MR ${iid}`, web_url: `${origin}/team/repo/-/merge_requests/${iid}`,
      source_branch: source, target_branch: target, source_project_id: sourceProject, target_project_id: 2,
    });
    const opened = [
      // A release merge request out of the default branch is no lower layer.
      mergeRequest(9, 'main', 'production'),
      // A fork's branch of the same name is another branch.
      mergeRequest(10, 'feature', 'other', 1),
      mergeRequest(4, 'layer-one', 'main'),
      mergeRequest(5, 'feature', 'layer-one'),
      mergeRequest(6, 'layer-three', 'feature'),
      // Two on top of layer-three: the chain forks there and stops.
      mergeRequest(7, 'fork-a', 'layer-three'),
      mergeRequest(8, 'fork-b', 'layer-three'),
    ];
    const all = vi.fn(async (options) => {
      const items = opened.filter((item) => (!options.sourceBranch || item.source_branch === options.sourceBranch)
        && (!options.targetBranch || item.target_branch === options.targetBranch));
      return options.showExpanded ? { data: items, paginationInfo: { next: null } } : items;
    });
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, all, allCommits: list([]), show: vi.fn(async () => mergeRequest(5, 'feature', 'layer-one')) },
      MergeRequestDiscussions: { all: list([]) },
    });

    const result = await service.changeRequestContext('/repo', 5, { includeTimeline: true });
    expect(result.stack).toEqual({
      number: null,
      base: 'main',
      layers: [4, 5, 6].map((iid) => expect.objectContaining({ number: iid, state: 'open', head: opened.find((item) => item.iid === iid).source_branch })),
    });
  });

  it('reads a thread as notes that say which thread they are in and its state', async () => {
    const discussions = [
      { id: 'abc', individual_note: false, notes: [
        { id: 10, body: 'Rename this', resolvable: true, resolved: true, author: { id: 3, username: 'sam' } },
        { id: 11, body: 'Done', resolvable: true, resolved: true, author: { id: 4, username: 'ann' } },
      ] },
      { id: 'def', individual_note: true, notes: [{ id: 12, body: 'Plain comment', author: { id: 3, username: 'sam' } }] },
    ];
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, allCommits: list([]) },
      MergeRequestDiscussions: { all: list(discussions) },
    });

    const result = await service.changeRequestContext('/repo', 5, { includeTimeline: true });
    expect(result.issueComments.map((note) => [note.body, note.thread ?? null])).toEqual([
      ['Rename this', { id: 'abc', resolved: true, resolvable: true, first: true }],
      ['Done', { id: 'abc', resolved: true, resolvable: true, first: false }],
      ['Plain comment', null],
    ]);
  });

  it("says what this account may do with a thread when GitLab's GraphQL answers", async () => {
    const post = vi.fn(async () => ({ body: { data: { project: { mergeRequest: {
      discussionLocked: true,
      userPermissions: { createNote: true },
      discussions: { nodes: [{ id: 'gid://gitlab/Discussion/abc', notes: { nodes: [{ userPermissions: { resolveNote: false } }] } }] },
    } } } } }));
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, allCommits: list([]), requester: { post } },
      MergeRequestDiscussions: { all: list([{ id: 'abc', individual_note: false, notes: [{ id: 10, body: 'Rename', resolvable: true, resolved: false, author: { id: 3, username: 'sam' } }] }]) },
    });

    const result = await service.changeRequestContext('/repo', 5, { includeTimeline: true });
    // A locked discussion takes no replies, and this account may not resolve the thread.
    expect(result.issueComments[0].thread).toEqual({ id: 'abc', resolved: false, resolvable: true, first: true, canResolve: false, canReply: false });
  });

  it('starts, answers and resolves threads on the merge request the path names', async () => {
    const thread = { id: 'abc', individual_note: false, notes: [{ id: 10, body: 'x', resolvable: true, resolved: true }] };
    const discussions = {
      create: vi.fn(async () => ({ ...thread, notes: [{ id: 10, body: 'x', resolvable: true, resolved: false }] })),
      addNote: vi.fn(async () => ({ id: 11, body: 'y' })),
      resolve: vi.fn(async () => thread),
      show: vi.fn(async () => thread),
    };
    const { service } = setup({ MergeRequestDiscussions: discussions });
    const providerTarget = { projectId: '2', number: 5 };

    await service.startThread({ providerTarget, body: 'x' });
    await service.replyToThread({ providerTarget, threadId: 'abc', body: 'y' });
    await service.resolveThread({ providerTarget, threadId: 'abc', resolved: true });
    await expect(service.resolveThread({ providerTarget, threadId: 'abc', resolved: false })).rejects.toThrow('invalid thread');
    expect(discussions.create).toHaveBeenCalledWith('2', 5, 'x');
    expect(discussions.addNote).toHaveBeenCalledWith('2', 5, 'abc', 'y');
    expect(discussions.resolve).toHaveBeenCalledWith('2', 5, 'abc', true);

    await expect(service.reconcileThreadResolve(providerTarget, 'abc', true)).resolves.toEqual({ state: 'succeeded', result: {} });
    await expect(service.reconcileThreadResolve(providerTarget, 'abc', false)).resolves.toEqual({ state: 'outcome-unknown' });
  });

  it('keeps merge-request context when CI jobs fail', async () => {
    const { service } = setup({ Jobs: { all: vi.fn(async () => { throw new Error('jobs unavailable'); }) } });
    const result = await service.changeRequestContext('/repo', 5, { includeDiff: true, includeCIDetails: true });
    expect(result).toMatchObject({ changeRequest: { number: 5 }, files: [{ path: 'a.ts' }], issueComments: [{ body: 'Looks good' }], ci: null });
  });

  it('counts the lines of a file too large for GitLab to send its diff', async () => {
    const post = vi.fn(async () => ({ body: { data: { project: { mergeRequest: { diffStats: [
      { path: 'small.ts', additions: 1, deletions: 1 },
      { path: 'huge.json', additions: 140, deletions: 2500 },
    ] } } } } }));
    const diffs = [
      { old_path: 'small.ts', new_path: 'small.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { old_path: 'huge.json', new_path: 'huge.json', diff: '', too_large: true },
    ];
    const { service } = setup({ MergeRequests: { ...setup().client.MergeRequests, allDiffs: list(diffs), requester: { post } } });

    const result = await service.changeRequestContext('/repo', 5, { includeDiff: true });
    expect(result.files).toMatchObject([
      { path: 'small.ts', additions: 1, deletions: 1 },
      { path: 'huge.json', additions: 140, deletions: 2500 },
    ]);
    expect(post).toHaveBeenCalledWith('../graphql', { body: { query: expect.stringContaining('diffStats'), variables: { path: 'me/repo', iid: '5' } } });

    // Without GitLab's counts the hunks are counted, as before.
    post.mockRejectedValueOnce(new Error('GraphQL unavailable'));
    const fallback = await service.changeRequestContext('/repo', 5, { includeDiff: true });
    expect(fallback.files).toMatchObject([{ additions: 1, deletions: 1 }, { additions: 0, deletions: 0 }]);
  });

  it('carries merge request labels with their colours', async () => {
    const labelled = { ...openMR, labels: [{ name: 'bug', color: '#d73a4a' }, 'docs'] };
    const { service, client } = setup({ MergeRequests: { ...setup().client.MergeRequests, all: list([labelled]) } });

    const page = await service.listChangeRequests('/repo');
    expect(page.items[0].labels).toEqual([{ name: 'bug', color: 'd73a4a' }, { name: 'docs' }]);
    expect(client.MergeRequests.all).toHaveBeenCalledWith(expect.objectContaining({ withLabelsDetails: true }));
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
      MergeRequestNotes: { all: list(notes) },
      MergeRequests: { ...setup().client.MergeRequests, allDiffs: list(diffs) },
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
    // GitBeaker reads a bare first argument as a global issue id; the project's
    // issue number goes first with the project beside it.
    for (const [number, options] of client.Issues.show.mock.calls) {
      expect(number).toBe(3);
      expect(options).toMatchObject({ projectId: expect.anything() });
    }
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
      Issues: { ...setup().client.Issues, all: list([{ iid: 3, state: 'opened' }]) },
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
      Branches: { all: list([{ name: 'main' }, {}]) },
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
      Issues: { ...setup().client.Issues, all: list([issue]), show: vi.fn(async () => issue) },
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
    const malformedNotes = setup({ IssueNotes: { all: list(notes) } }, { canonicalReads: true });
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

  it('rejects a mutation on a merge request whose target project is outside the allowed network', async () => {
    const outside = { ...openMR, target_project_id: 99 };
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
    const mergeRequests = { ...setup().client.MergeRequests, all: list([exact]) };
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

  it('pages by GitLab next-page headers without skipping records', async () => {
    const page = Array.from({ length: 20 }, (_, index) => ({ ...openMR, iid: index + 1 }));
    const { service, client } = setup({ MergeRequests: { ...setup().client.MergeRequests, all: list(page, 2) } });
    const result = await service.listChangeRequests('/repo', { page: 1 });
    expect(result).toMatchObject({ hasMore: true });
    expect(result.items).toHaveLength(20);
    expect(client.MergeRequests.all).toHaveBeenCalledWith(expect.objectContaining({ perPage: 20, page: 1, showExpanded: true }));
    const issues = setup({ Issues: { ...setup().client.Issues, all: list([], 3) } });
    await expect(issues.service.listIssues('/repo', { page: 2 })).resolves.toMatchObject({ hasMore: true });
    expect(issues.client.Issues.all).toHaveBeenCalledWith(expect.objectContaining({ perPage: 20, page: 2 }));
  });

  it('fails instead of returning a capped collection as complete', async () => {
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, allDiffs: list([{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@' }], 21) },
    });
    await expect(service.changeRequestContext('/repo', 5, { includeDiff: true })).rejects.toThrow('more changed files');
    const branches = setup({ Branches: { all: list([{ name: 'main' }], 21) } });
    await expect(branches.service.projectBranches('/repo', { owner: 'team', name: 'repo' })).rejects.toThrow('more branches');
  });

  it('reads fork pipeline jobs from the pipeline project', async () => {
    const forkMR = { ...openMR, head_pipeline: { id: 9, status: 'running', project_id: 1 } };
    const { service, client } = setup({ MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => forkMR) } });
    await service.changeRequestContext('/repo', 5, { includeCIDetails: true });
    expect(client.Jobs.all).toHaveBeenCalledWith(1, expect.objectContaining({ pipelineId: 9 }));
  });

  it('names the fork source project as the merge request head project', async () => {
    const { service } = setup({
      Projects: { show: vi.fn(async (id) => (Number(id) === 2 || id === 'team/repo' ? targetProject : sourceProject)) },
    });
    const result = await service.changeRequestContext('/repo', 5, { project: { owner: 'team', name: 'repo' } });
    expect(result.changeRequest).toMatchObject({ project: { id: '2' }, headProject: { id: '1', owner: 'me', name: 'repo' } });
  });

  it('merges only the reviewed head and reports a moved head as a target mismatch', async () => {
    const merge = vi.fn(async () => ({ ...openMR, state: 'merged', sha: 'abc' }));
    const payload = {
      providerTarget: { projectId: '2', number: 5 },
      targetProject: { id: '2', owner: 'team', name: 'repo' },
      expectedTarget: { project: { id: '2', owner: 'team', name: 'repo' }, number: 5, headSha: 'abc' },
      method: 'merge',
    };
    const { service } = setup({ MergeRequests: { ...setup().client.MergeRequests, merge } });
    await service.mergeChangeRequest(payload);
    expect(merge).toHaveBeenCalledWith('2', 5, expect.objectContaining({ sha: 'abc' }));
    const moved = Object.assign(new Error('SHA does not match HEAD of source branch'), { cause: { response: { status: 409 } } });
    const rejected = setup({ MergeRequests: { ...setup().client.MergeRequests, merge: vi.fn(async () => { throw moved; }) } });
    await expect(rejected.service.mergeChangeRequest(payload)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409 });
  });
});

describe('GitLab comments and reviews', () => {
  const review = (overrides = {}) => ({
    providerTarget: { projectId: '2', number: 5 },
    targetProject: { id: '2', owner: 'team', name: 'repo' },
    expectedTarget: { project: { id: '2', owner: 'team', name: 'repo' }, number: 5, headSha: 'abc' },
    verdict: 'approve',
    ...overrides,
  });
  const notes = (create) => ({ MergeRequestNotes: { ...setup().client.MergeRequestNotes, create } });

  it('approves the commit the user read, then posts the text as a note', async () => {
    const approve = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({ id: 7 }));
    const { service } = setup({ MergeRequestApprovals: { approve }, ...notes(create) });

    await expect(service.reviewChangeRequest(review({ body: 'Nice' }))).resolves.toEqual({ commented: true });
    await expect(service.reviewChangeRequest(review())).resolves.toEqual({ commented: false });

    expect(approve).toHaveBeenCalledWith('2', 5, { sha: 'abc' });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith('2', 5, 'Nice');
  });

  it('keeps the verdict when its note fails and says the text did not post', async () => {
    const create = vi.fn(async () => { throw Object.assign(new Error('locked'), { cause: { response: { status: 403 } } }); });
    const { service } = setup({ MergeRequestApprovals: { approve: vi.fn(async () => ({})) }, ...notes(create) });

    await expect(service.reviewChangeRequest(review({ body: 'Nice' }))).resolves.toEqual({ commented: false });
  });

  it('turns an approval GitLab does not allow into a refusal, not a lost sign-in', async () => {
    const refused = Object.assign(new Error('401 Unauthorized'), { cause: { response: { status: 401 } } });
    const moved = Object.assign(new Error('SHA does not match'), { cause: { response: { status: 409 } } });
    const own = setup({ MergeRequestApprovals: { approve: vi.fn(async () => { throw refused; }) } });
    const late = setup({ MergeRequestApprovals: { approve: vi.fn(async () => { throw moved; }) } });

    await expect(own.service.reviewChangeRequest(review())).rejects.toMatchObject({ status: 403 });
    await expect(late.service.reviewChangeRequest(review())).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409 });
  });

  it('requests changes through GraphQL and reports its errors as a refusal', async () => {
    const post = vi.fn(async () => ({ body: { data: { mergeRequestRequestChanges: { mergeRequest: { iid: '5' }, errors: [] } } } }));
    const { service } = setup({ MergeRequests: { ...setup().client.MergeRequests, requester: { post } } });

    await expect(service.reviewChangeRequest(review({ verdict: 'request-changes' }))).resolves.toEqual({ commented: false });
    expect(post).toHaveBeenCalledWith('../graphql', {
      body: { query: expect.stringContaining('mergeRequestRequestChanges'), variables: { path: 'team/repo', iid: '5' } },
    });

    post.mockResolvedValueOnce({ body: { data: { mergeRequestRequestChanges: { mergeRequest: null, errors: ['Reviewer not found'] } } } });
    await expect(service.reviewChangeRequest(review({ verdict: 'request-changes' }))).rejects.toMatchObject({ message: 'Reviewer not found', status: 422 });
    post.mockResolvedValueOnce({ body: { data: null, errors: [{ message: "Field 'mergeRequestRequestChanges' doesn't exist" }] } });
    await expect(service.reviewChangeRequest(review({ verdict: 'request-changes' }))).rejects.toMatchObject({ status: 422 });
  });

  it('reads labels and active members, and sets labels and reviewers as whole sets', async () => {
    const editMR = vi.fn(async (_id, _iid, update) => ({ ...openMR, labels: update.labels?.split(',') ?? [] }));
    const editIssue = vi.fn(async () => ({ iid: 3, title: 'Bug', web_url: `${origin}/me/repo/-/issues/3`, state: 'opened' }));
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, edit: editMR, show: vi.fn(async () => ({ ...openMR, labels: ['bug'], reviewers: [{ id: 7, username: 'ann' }] })) },
      Issues: { ...setup().client.Issues, edit: editIssue },
      ProjectLabels: { all: vi.fn(async () => [{ name: 'bug', color: '#d73a4a' }, { name: '' }]) },
      ProjectMembers: { all: vi.fn(async () => [
        { id: 7, username: 'ann', avatar_url: `${origin}/a.png`, state: 'active' },
        { id: 8, username: 'gone', state: 'blocked' },
      ]) },
    });
    const project = { id: '2', owner: 'team', name: 'repo' };

    await expect(service.listLabels('/repo', { owner: 'team', name: 'repo' })).resolves.toEqual([{ name: 'bug', color: 'd73a4a' }]);
    await expect(service.listReviewerCandidates('/repo', { owner: 'team', name: 'repo' }))
      .resolves.toEqual([{ id: '7', login: 'ann', avatarUrl: `${origin}/a.png` }]);

    await service.setLabels({ kind: 'change-request-labels', labels: ['bug', 'docs'], providerTarget: { projectId: '2', number: 5 } });
    await service.setLabels({ kind: 'issue-labels', labels: [], providerTarget: { projectId: '1', number: 3 } });
    await service.setReviewers({
      reviewers: ['7'], providerTarget: { projectId: '2', number: 5 }, targetProject: project, expectedTarget: { project, number: 5 },
    });
    expect(editMR).toHaveBeenNthCalledWith(1, '2', 5, { labels: 'bug,docs' });
    expect(editIssue).toHaveBeenCalledWith('1', 3, { labels: '' });
    expect(editMR).toHaveBeenNthCalledWith(2, '2', 5, { reviewerIds: [7] });

    await expect(service.reconcileSetMutation({ projectId: '2', number: 5 }, 'change-request-labels', ['bug'])).resolves.toMatchObject({ state: 'succeeded' });
    await expect(service.reconcileSetMutation({ projectId: '2', number: 5 }, 'change-request-reviewers', ['7'])).resolves.toMatchObject({ state: 'succeeded' });
    await expect(service.reconcileSetMutation({ projectId: '2', number: 5 }, 'change-request-labels', ['docs'])).resolves.toEqual({ state: 'outcome-unknown' });
  });

  it('closes and reopens through stateEvent and reconciles from the current state', async () => {
    const editMR = vi.fn(async () => ({ ...openMR, state: 'closed' }));
    const editIssue = vi.fn(async () => ({ iid: 3, title: 'Bug', web_url: `${origin}/me/repo/-/issues/3`, state: 'opened' }));
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, edit: editMR },
      Issues: { ...setup().client.Issues, edit: editIssue },
    });
    const project = { id: '2', owner: 'team', name: 'repo' };

    await expect(service.setChangeRequestState({
      state: 'closed', providerTarget: { projectId: '2', number: 5 }, targetProject: project, expectedTarget: { project, number: 5 },
    })).resolves.toEqual({ state: 'closed' });
    await expect(service.setIssueState({
      state: 'open', providerTarget: { projectId: '1', number: 3 }, targetProject: { id: '1', owner: 'me', name: 'repo' },
    })).resolves.toEqual({ state: 'open' });
    expect(editMR).toHaveBeenCalledWith('2', 5, { stateEvent: 'close' });
    expect(editIssue).toHaveBeenCalledWith('1', 3, { stateEvent: 'reopen' });

    await expect(service.reconcileStateMutation({ projectId: '2', number: 5 }, 'change-request-state', 'open'))
      .resolves.toEqual({ state: 'succeeded', result: { state: 'open' } });
    await expect(service.reconcileStateMutation({ projectId: '1', number: 3 }, 'issue-state', 'closed'))
      .resolves.toMatchObject({ state: 'failed' });
  });

  it('comments on merge requests and on issues in the bound project', async () => {
    const mrNote = vi.fn(async () => ({ id: 8 }));
    const issueNote = vi.fn(async () => ({ id: 9 }));
    const { service, client } = setup({ ...notes(mrNote), IssueNotes: { ...setup().client.IssueNotes, create: issueNote } });
    const context = { directory: '/repo', repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin' };

    const resolved = await service.resolveIssueMutation(context, { project: { owner: 'me', name: 'repo' }, number: 3 });
    await service.commentIssue({ providerTarget: resolved.providerTarget, body: 'On it' });
    await service.commentChangeRequest({ providerTarget: { projectId: '2', number: 5 }, body: 'Looks good' });

    expect(resolved).toEqual({
      providerTarget: { projectId: '1', number: 3 },
      target: { repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin', project: { id: '1', owner: 'me', name: 'repo' }, number: 3 },
    });
    expect(client.Issues.show).toHaveBeenCalledWith(3, { projectId: '1' });
    expect(issueNote).toHaveBeenCalledWith('1', 3, 'On it');
    expect(mrNote).toHaveBeenCalledWith('2', 5, 'Looks good');
    await expect(service.resolveIssueMutation(context, { project: { owner: 'me', name: 'repo' }, number: 3, headSha: 'abc' }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
  });
});

describe('GitLab merge request comparison reads', () => {
  const diffRefs = { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40) };

  it('rebuilds git file headers around the hunks GitLab sends', async () => {
    const { service, client } = setup({
      MergeRequests: {
        ...setup().client.MergeRequests,
        allDiffs: list([
          { old_path: 'a.ts', new_path: 'a.ts', a_mode: '100644', b_mode: '100644', diff: '@@ -1 +1 @@\n-old\n+new\n' },
          { old_path: 'new.md', new_path: 'new.md', a_mode: '0', b_mode: '100644', new_file: true, diff: '@@ -0,0 +1 @@\n+hello' },
          { old_path: 'gone.txt', new_path: 'gone.txt', a_mode: '100644', b_mode: '0', deleted_file: true, diff: '@@ -1 +0,0 @@\n-bye\n' },
          { old_path: 'old/name.ts', new_path: 'new/name.ts', a_mode: '100644', b_mode: '100644', renamed_file: true, diff: '' },
          { old_path: 'run.sh', new_path: 'run.sh', a_mode: '100644', b_mode: '100755', diff: '' },
        ]),
      },
    });
    const { patch, meta } = await service.changeRequestPatch('/repo', 5, { project: { owner: 'team', name: 'repo' }, remote: 'origin' });
    expect(meta).toEqual({ owner: 'team', repo: 'repo', number: 5 });
    expect(patch).toBe([
      'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new',
      'diff --git a/new.md b/new.md', 'new file mode 100644', '--- /dev/null', '+++ b/new.md', '@@ -0,0 +1 @@', '+hello',
      'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
      'diff --git a/old/name.ts b/new/name.ts', 'rename from old/name.ts', 'rename to new/name.ts',
      'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755',
      '',
    ].join('\n'));
    // GitLab before 18.0 fails a diff page larger than 30 with 500; the bound on files stays 2000.
    expect(client.MergeRequests.allDiffs).toHaveBeenCalledWith('2', 5, expect.objectContaining({ showExpanded: true, perPage: 30, maxPages: 67 }));
  });

  it('reads both sides of a file at the merge base and the head', async () => {
    const showRaw = vi.fn(async (_project, path, ref) => `${path}@${ref.slice(0, 1)}`);
    const { service } = setup({
      MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => ({ ...openMR, diff_refs: diffRefs })) },
      RepositoryFiles: { showRaw },
    });
    const project = { owner: 'team', name: 'repo' };
    await expect(service.changeRequestFileContents('/repo', 5, { project, remote: 'origin', path: 'b.ts', previousPath: 'a.ts', status: 'R' }))
      .resolves.toEqual({ original: 'a.ts@a', modified: 'b.ts@b' });
    await expect(service.changeRequestFileContents('/repo', 5, { project, remote: 'origin', path: 'new.ts', status: 'A' }))
      .resolves.toEqual({ original: '', modified: 'new.ts@b' });
    expect(showRaw).toHaveBeenCalledWith('2', 'a.ts', diffRefs.base_sha);
  });

  it('refuses a merge request outside the bound repository network', async () => {
    const { service, client } = setup({
      MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => ({ ...openMR, target_project_id: 99 })) },
    });
    await expect(service.changeRequestPatch('/repo', 5, { project: { owner: 'team', name: 'repo' }, remote: 'origin' }))
      .rejects.toThrow();
    expect(client.MergeRequests.allDiffs).not.toHaveBeenCalled();
  });
});


describe("GitLab fork merge requests through the maintainer's upstream clone", () => {
  // The clone's remote is team/repo, which forks nothing: the network is team/repo
  // alone, and me/repo, where !5's source branch lives, is not in it.
  const diffRefs = { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40) };
  const forkMR = { ...openMR, sha: diffRefs.head_sha, diff_refs: diffRefs };
  const upstream = { owner: 'team', name: 'repo' };
  const context = { directory: '/repo', repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin' };
  const setupUpstream = (overrides = {}) => {
    const result = setup({
      Projects: { show: vi.fn(async (id) => (Number(id) === 2 || id === 'team/repo' ? targetProject : sourceProject)) },
      ...overrides,
      MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => forkMR), ...overrides.MergeRequests },
    }, { canonicalReads: true });
    result.resolveProjects.mockImplementation(async () => ({
      branch: 'main', tracking: 'origin/main',
      projects: [{ projectPath: 'team/repo', remoteName: 'origin', url: `${origin}/team/repo` }],
    }));
    return result;
  };

  it("reads the patch, both sides of a file at the fork's head and the context from the upstream", async () => {
    const showRaw = vi.fn(async (_project, path, ref) => `${path}@${ref.slice(0, 1)}`);
    const { service, client } = setupUpstream({ RepositoryFiles: { showRaw } });

    await expect(service.changeRequestPatch('/repo', 5, { project: upstream, remote: 'origin' }))
      .resolves.toMatchObject({ meta: { owner: 'team', repo: 'repo', number: 5 } });
    await expect(service.changeRequestFileContents('/repo', 5, { project: upstream, remote: 'origin', path: 'a.ts', status: 'M' }))
      .resolves.toEqual({ original: 'a.ts@a', modified: 'a.ts@b' });
    const result = await service.changeRequestContext('/repo', 5, { project: upstream, remote: 'origin', constrainToPrimary: true });

    expect(result.changeRequest).toMatchObject({ project: { id: '2' }, headProject: { id: '1', owner: 'me', name: 'repo' } });
    expect(client.MergeRequests.allDiffs).toHaveBeenCalledWith('2', 5, expect.anything());
    expect(showRaw).toHaveBeenCalledWith('2', 'a.ts', diffRefs.head_sha);
  });

  it('comments on and merges the fork merge request', async () => {
    const create = vi.fn(async () => ({ id: 8 }));
    const merge = vi.fn(async () => ({ ...forkMR, state: 'merged' }));
    const { service } = setupUpstream({ MergeRequestNotes: { ...setup().client.MergeRequestNotes, create }, MergeRequests: { merge } });

    const resolved = await service.resolveChangeRequestMutation(context, { project: upstream, number: 5, headSha: diffRefs.head_sha });
    expect(resolved.target).toMatchObject({ project: { id: '2', owner: 'team', name: 'repo' }, number: 5, headSha: diffRefs.head_sha });
    await service.commentChangeRequest({ providerTarget: resolved.providerTarget, body: 'Thanks' });
    await expect(service.mergeChangeRequest({
      providerTarget: resolved.providerTarget, targetProject: resolved.target.project, expectedTarget: resolved.target, method: 'merge',
    })).resolves.toMatchObject({ merged: true });

    expect(create).toHaveBeenCalledWith('2', 5, 'Thanks');
    expect(merge).toHaveBeenCalledWith('2', 5, expect.objectContaining({ sha: diffRefs.head_sha }));
  });

  it('still refuses a merge request whose target is outside the network', async () => {
    const { service, client } = setupUpstream();

    // me/repo is not in team/repo's network, so no selector reaches it.
    await expect(service.changeRequestPatch('/repo', 5, { project: { owner: 'me', name: 'repo' }, remote: 'origin' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.resolveChangeRequestMutation(context, { project: { owner: 'me', name: 'repo' }, number: 5 }))
      .rejects.toMatchObject({ status: 404 });
    expect(client.MergeRequests.show).not.toHaveBeenCalled();
  });
});

describe('GitLab live summaries', () => {
  it('maps merge request and issue state onto the shared badge shape and skips what GitLab cannot answer', async () => {
    const byNumber = {
      1: { ...openMR, iid: 1, has_conflicts: true, detailed_merge_status: 'conflict', head_pipeline: { status: 'success' } },
      2: { ...openMR, iid: 2, detailed_merge_status: 'not_approved', head_pipeline: { status: 'failed' } },
      3: { ...openMR, iid: 3, detailed_merge_status: 'mergeable', head_pipeline: { status: 'running' }, draft: true },
      4: { ...openMR, iid: 4, state: 'merged', detailed_merge_status: 'not_open', head_pipeline: { status: 'success' } },
    };
    const { service, client } = setup({
      MergeRequests: {
        ...setup().client.MergeRequests,
        show: vi.fn(async (_path, number) => {
          if (!byNumber[number]) throw Object.assign(new Error('404 Not Found'), { cause: { response: { status: 404 } } });
          return byNumber[number];
        }),
      },
      Issues: { ...setup().client.Issues, show: vi.fn(async (number) => ({ iid: number, title: 'Bug', state: number === 8 ? 'closed' : 'opened' })) },
    });
    const ref = (number) => ({ owner: 'group/sub', repo: 'app', number });
    const { summaries, issueSummaries } = await service.liveSummaries({ refs: [1, 2, 3, 4, 5].map(ref), issueRefs: [7, 8].map(ref) });

    expect(summaries.map((s) => [s.number, s.state, s.draft, s.mergeable, s.mergeableState, s.checks?.state ?? null])).toEqual([
      [1, 'open', false, false, 'dirty', 'success'],
      // Waiting for approval is nothing to fix: no `blocked` state, so the open colour.
      [2, 'open', false, null, null, 'failure'],
      [3, 'open', true, true, 'clean', 'pending'],
      [4, 'merged', false, null, null, null],
    ]);
    expect(issueSummaries.map((s) => [s.number, s.state])).toEqual([[7, 'open'], [8, 'completed']]);
    expect(client.MergeRequests.show).toHaveBeenCalledWith('group/sub/app', 1);
    expect(client.Issues.show).toHaveBeenCalledWith(7, { projectId: 'group/sub/app' });
  });

  it('fails the whole read when GitLab refuses the token', async () => {
    const refused = Object.assign(new Error('401 Unauthorized'), { cause: { response: { status: 401 } } });
    const { service } = setup({ MergeRequests: { ...setup().client.MergeRequests, show: vi.fn(async () => { throw refused; }) } });
    await expect(service.liveSummaries({ refs: [{ owner: 'team', repo: 'app', number: 1 }] })).rejects.toBe(refused);
  });
});
