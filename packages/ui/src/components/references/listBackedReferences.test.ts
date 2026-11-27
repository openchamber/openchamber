import { describe, expect, test } from 'bun:test';
import type { ChangeRequest, ChangeRequestContext, Issue, SourceControlReadContext } from '@/lib/api/types';
import { githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { fetchListBackedReferenceDetail, fetchListBackedReferencePage, type ListBackedProvider } from './listBackedReferences';
import { DEFAULT_REPOSITORY_FILTER, referenceNumberLabel, referencePickerItemKey } from './referencePickerItems';

const identity = { provider: 'gitlab' as const, instance: 'https://gitlab.com' };
const context: SourceControlReadContext = {
  ...identity,
  accountId: 'https://gitlab.com#1',
  repositoryId: 'repo-1',
  bindingRevision: 1,
  directory: '/repo',
  primaryRemote: 'origin',
};
const project = { ...identity, id: 'group/sub/app', owner: 'group/sub', name: 'app', url: 'https://gitlab.com/group/sub/app' };
const issue: Issue = { ...identity, id: 'i1', number: 3, project, title: 'Crash', url: 'https://gitlab.com/group/sub/app/-/issues/3', state: 'closed', body: 'boom' };
const mergeRequest: ChangeRequest = {
  ...identity, id: 'm1', number: 7, project, title: 'Fix', url: 'https://gitlab.com/group/sub/app/-/merge_requests/7',
  state: 'open', draft: false, base: 'main', head: 'fix', headSha: 'abc',
};

const gitlab = gitlabLikeDescriptor();
const descriptors = [githubLikeDescriptor(), gitlab];
const provider: ListBackedProvider = { descriptor: gitlab, urls: createRepositoryUrlMatcher(descriptors, []) };

const reads = (overrides: Partial<Parameters<typeof fetchListBackedReferencePage>[0]> = {}) => ({
  issuesList: async () => ({ items: [issue], page: 1, hasMore: true }),
  changeRequestsList: async () => ({ items: [mergeRequest], page: 2, hasMore: false }),
  issueComments: async () => [],
  changeRequestContext: async (): Promise<ChangeRequestContext> => ({ identity, project, changeRequest: mergeRequest, issueComments: [], reviewComments: [], files: [] }),
  issueGet: async (): Promise<Issue | null> => issue,
  ...overrides,
});

describe('list-backed references', () => {
  test('a page of issues reads as picker rows, closed as done, with the next page as cursor', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page') throw new Error('expected a page');
    expect(page.items[0]).toMatchObject({ kind: 'issue', provider: 'gitlab', number: 3, state: 'completed', sourceRepo: { owner: 'group/sub', repo: 'app' } });
    expect(page.cursor).toBe('2');
    expect(referenceNumberLabel(page.items[0]!, gitlab)).toBe('#3');
  });

  test('merge requests carry their branches and read as !N', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, 'fix', '2');
    if (page.kind !== 'page') throw new Error('expected a page');
    expect(page.items[0]).toMatchObject({ kind: 'pull', head: 'fix', base: 'main', headSha: 'abc' });
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
    expect(referenceNumberLabel(page.items[0]!, gitlab)).toBe('!7');
  });

  test('issue #N and merge request !N select as different items', async () => {
    const issues = await fetchListBackedReferencePage(reads({ issuesList: async () => ({ items: [{ ...issue, number: 7 }], page: 1, hasMore: false }) }), context, provider, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    const pulls = await fetchListBackedReferencePage(reads(), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (issues.kind !== 'page' || pulls.kind !== 'page') throw new Error('expected pages');
    const issueKey = referencePickerItemKey({ source: 'repository', reference: issues.items[0]! });
    const pullKey = referencePickerItemKey({ source: 'repository', reference: pulls.items[0]! });
    expect(issueKey).toBe('gitlab:group/sub/app#7');
    expect(pullKey).toBe('gitlab:group/sub/app!7');
  });

  test('a number or a link reads that one item instead of searching titles', async () => {
    const searched: string[] = [];
    let readNumber: number | null = null;
    let readProject: { owner: string; name: string } | undefined;
    const lookups = reads({
      changeRequestsList: async (_context, options) => {
        searched.push(options?.query ?? '');
        return { items: [], page: 1, hasMore: false };
      },
      changeRequestContext: async (_context, number, options) => {
        readNumber = number;
        readProject = options?.project;
        return { identity, project, changeRequest: mergeRequest, issueComments: [], reviewComments: [], files: [] };
      },
    });
    const byNumber = await fetchListBackedReferencePage(lookups, context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '!7', null);
    if (byNumber.kind !== 'page') throw new Error('expected a page');
    expect(byNumber.items.map((item) => item.number)).toEqual([7]);
    expect(readNumber).toBe(7);

    await fetchListBackedReferencePage(lookups, context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, 'https://gitlab.com/group/sub/app/-/merge_requests/7', null);
    expect(readProject).toEqual({ owner: 'group/sub', name: 'app' });

    const issueByLink = await fetchListBackedReferencePage(lookups, context, provider, 'issue', DEFAULT_REPOSITORY_FILTER, 'https://gitlab.com/group/sub/app/-/issues/3', null);
    if (issueByLink.kind !== 'page') throw new Error('expected a page');
    expect(issueByLink.items.map((item) => item.number)).toEqual([3]);

    await fetchListBackedReferencePage(lookups, context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, 'crash on save', null);
    // A link to another provider's item is searched, not read here.
    await fetchListBackedReferencePage(lookups, context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, 'https://github.com/acme/app/pull/7', null);
    expect(searched).toEqual(['crash on save', 'https://github.com/acme/app/pull/7']);
  });

  test('a page passes the state and whose items to GitLab', async () => {
    let seen: { state?: string; people?: string } | undefined;
    await fetchListBackedReferencePage(reads({ changeRequestsList: async (_context, options) => {
      seen = options;
      return { items: [], page: 1, hasMore: false };
    } }), context, provider, 'pull', { state: 'merged', people: 'reviewRequested', labels: [] }, '', null);
    expect(seen).toMatchObject({ page: 1, state: 'merged', people: 'reviewRequested' });
  });

  test('the preview reads a merge request through its context', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page') throw new Error('expected a page');
    let askedCIDetails: boolean | undefined;
    const detail = await fetchListBackedReferenceDetail(reads({
      changeRequestContext: async (_context, _number, options) => {
        askedCIDetails = options?.includeCIDetails;
        return {
          identity, project, changeRequest: mergeRequest,
          issueComments: [{ ...identity, id: 'c1', url: 'u', body: 'later', createdAt: '2026-02-01' }],
          reviewComments: [{ ...identity, id: 'c2', url: 'u2', body: 'earlier', createdAt: '2026-01-01', path: 'a.ts', line: 4 }],
          files: [{ path: 'a.ts', additions: 3, deletions: 1 }, { path: 'b.ts', additions: 2 }],
          ci: { summary: { state: 'success', total: 1, success: 1, failure: 0, pending: 0 } },
          commits: [{ sha: 'aaa', headline: 'first', authorName: 'Sam', committedAt: '2025-12-31', url: null }],
          commitsComplete: false,
          verdicts: [{ state: 'approved', createdAt: '2026-01-15', url: 'v' }],
          reviewerStates: [
            { user: { ...identity, id: '7', username: 'ann', avatarUrl: 'https://gitlab.com/ann.png' }, state: 'approved' },
            { user: { ...identity, id: '8', username: 'bo' }, state: 'pending' },
          ],
        };
      },
    }), context, page.items[0]!);
    // The pipeline's totals come from its jobs, which only CI details read.
    expect(askedCIDetails).toBe(true);
    expect(detail.comments.map((comment) => [comment.body, comment.review])).toEqual([['earlier', null], ['', 'approved'], ['later', null]]);
    expect(detail.comments[0]).toMatchObject({ path: 'a.ts', line: 4 });
    expect(detail.pull).toMatchObject({ additions: 5, deletions: 1, changedFiles: 2, checks: { state: 'success' } });
    // Only the newest commits came, so the total is unknown.
    expect(detail.pull).toMatchObject({ commits: [{ sha: 'aaa', headline: 'first', author: null, authorName: 'Sam' }], commitTotal: null });
    expect(detail.pull?.reviewerStates).toEqual([
      { id: '7', login: 'ann', avatarUrl: 'https://gitlab.com/ann.png', state: 'approved' },
      { id: '8', login: 'bo', state: 'pending' },
    ]);
  });

  test('the Board preview reads an issue, and its mentions, through issueGet', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    let askedReferences: boolean | undefined;
    const detail = await fetchListBackedReferenceDetail(reads({
      issueGet: async (_context, _number, _project, options) => {
        askedReferences = options?.includeReferences;
        return {
          ...issue,
          references: [{
            kind: 'issue', number: 9, title: 'Elsewhere', url: 'https://gitlab.com/group/sub/app/-/issues/9',
            repo: 'group/sub/app', createdAt: '2026-01-03T00:00:00Z', author: { login: 'sam' }, willCloseTarget: false,
          }],
        };
      },
      issueComments: async () => [{ ...identity, id: 'c1', url: 'u', body: 'A note', createdAt: '2026-01-02T00:00:00Z' }],
    }), context, page.items[0], { crossReferences: true });

    expect(askedReferences).toBe(true);
    expect(detail.comments.map((comment) => comment.body)).toEqual(['A note']);
    expect(detail.references).toEqual([{
      kind: 'issue', number: 9, title: 'Elsewhere', url: 'https://gitlab.com/group/sub/app/-/issues/9',
      repo: 'group/sub/app', createdAt: '2026-01-03T00:00:00Z', author: { login: 'sam' }, willCloseTarget: false,
    }]);
  });

  test('a failed mention read keeps the comments, and a failed comment read still fails', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    const note = { ...identity, id: 'c1', url: 'u', body: 'A note', createdAt: '2026-01-02T00:00:00Z' };
    const detail = await fetchListBackedReferenceDetail(reads({
      issueGet: async () => { throw new Error('timeline unavailable'); },
      issueComments: async () => [note],
    }), context, page.items[0], { crossReferences: true });
    expect(detail.comments.map((comment) => comment.body)).toEqual(['A note']);
    expect(detail).not.toHaveProperty('references');
    // Nobody read the set, so it is unknown and not empty.
    expect(detail).not.toHaveProperty('assignees');

    await expect(fetchListBackedReferenceDetail(reads({
      issueComments: async () => { throw new Error('comments unavailable'); },
    }), context, page.items[0], { crossReferences: true })).rejects.toThrow('comments unavailable');
  });

  test('previews outside the Board read the issue for its state, and never ask for mentions', async () => {
    const issues = await fetchListBackedReferencePage(reads(), context, provider, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    const pulls = await fetchListBackedReferencePage(reads(), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (issues.kind !== 'page' || !issues.items[0] || pulls.kind !== 'page' || !pulls.items[0]) throw new Error('expected pages');
    let issueReads = 0;
    let askedReferences: boolean | undefined;
    const quiet = reads({
      issueGet: async () => { issueReads += 1; return issue; },
      changeRequestContext: async (_context, _number, options) => {
        askedReferences = options?.includeReferences;
        // A provider may send mentions nobody asked for.
        return {
          identity, project, changeRequest: mergeRequest, issueComments: [], reviewComments: [], files: [],
          references: [{ kind: 'issue', number: 9, url: 'https://gitlab.com/group/sub/app/-/issues/9', createdAt: null }],
        };
      },
    });
    await fetchListBackedReferenceDetail(quiet, context, issues.items[0]);
    const pullDetail = await fetchListBackedReferenceDetail(quiet, context, pulls.items[0]);
    expect(issueReads).toBe(1);
    expect(askedReferences).toBeUndefined();
    expect(pullDetail).not.toHaveProperty('references');
    await fetchListBackedReferenceDetail(quiet, context, pulls.items[0], { crossReferences: true });
    expect(askedReferences).toBe(true);
  });

  test('an issue read carries the assignee set, an empty one included, and leaves one the host did not answer unknown', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    const reference = page.items[0];
    const read = (answer: Issue) => fetchListBackedReferenceDetail(reads({ issueGet: async () => answer }), context, reference);
    const assigned = await read({ ...issue, assignees: [{ ...identity, id: '7', username: 'ann' }], writeAccess: false });
    expect(assigned.assignees).toMatchObject([{ id: '7', login: 'ann' }]);
    expect(assigned.writeAccess).toBe(false);
    expect((await read({ ...issue, assignees: [] })).assignees).toEqual([]);
    expect(await read(issue)).not.toHaveProperty('assignees');
  });

  test('a GitLab note carries its id and write capabilities into the preview', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    const detail = await fetchListBackedReferenceDetail(reads({
      changeRequestContext: async () => ({
        identity, project, changeRequest: mergeRequest,
        issueComments: [{ ...identity, id: 'n1', url: 'u1', body: 'Nice', createdAt: '2026-01-01', canUpdate: true, canDelete: false }],
        reviewComments: [], files: [],
      }),
    }), context, page.items[0]);
    expect(detail.comments[0]).toMatchObject({ id: 'n1', canUpdate: true, canDelete: false });
    // A host that says nothing about reviewer state leaves the field absent.
    expect(detail.pull).not.toHaveProperty('reviewerStates');

    // A note the host says nothing about keeps its id and no capabilities, so the buttons stay.
    const silent = await fetchListBackedReferenceDetail(reads({
      changeRequestContext: async () => ({
        identity, project, changeRequest: mergeRequest,
        issueComments: [{ ...identity, id: 'n2', url: 'u2', body: 'Older', createdAt: '2026-01-02' }],
        reviewComments: [], files: [],
      }),
    }), context, page.items[0]);
    expect(silent.comments[0]).toMatchObject({ id: 'n2' });
    expect('canUpdate' in (silent.comments[0] ?? {})).toBe(false);
    expect('canDelete' in (silent.comments[0] ?? {})).toBe(false);
  });

  test('a thread reads as its first note with the answers under it', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    const thread = (first: boolean) => ({ id: 'abc', resolved: true, resolvable: true, first, canResolve: true, canReply: true });
    const detail = await fetchListBackedReferenceDetail(reads({
      changeRequestContext: async () => ({
        identity, project, changeRequest: mergeRequest,
        issueComments: [
          { ...identity, id: 'n2', url: 'u2', body: 'Done', createdAt: '2026-01-02', thread: thread(false) },
          { ...identity, id: 'n3', url: 'u3', body: 'Plain', createdAt: '2026-01-03' },
          // Its opener is not among the notes, so it stands on its own.
          { ...identity, id: 'n4', url: 'u4', body: 'Orphan', createdAt: '2026-01-04', thread: { ...thread(false), id: 'gone' } },
        ],
        reviewComments: [{ ...identity, id: 'n1', url: 'u1', body: 'Rename', createdAt: '2026-01-01', path: 'a.ts', line: 2, thread: thread(true) }],
        files: [],
      }),
    }), context, page.items[0]);
    expect(detail.comments.map((comment) => comment.body)).toEqual(['Rename', 'Plain', 'Orphan']);
    expect(detail.comments[0]?.thread).toMatchObject({ id: 'abc', resolved: true, outdated: false, canResolve: true, canReply: true, replies: [{ body: 'Done' }] });
  });

  test('keeps an outdated thread, drops its old line, and leaves unknown permissions to the host', async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    // No canResolve or canReply: a permission read that failed or ran past 100 threads.
    const outdated = { id: 'abc', resolved: false, resolvable: true, first: true, outdated: true };
    const denied = { id: 'def', resolved: false, resolvable: true, first: true, canResolve: false, canReply: false };
    const detail = await fetchListBackedReferenceDetail(reads({
      changeRequestContext: async () => ({
        identity, project, changeRequest: mergeRequest,
        issueComments: [],
        reviewComments: [
          { ...identity, id: 'n1', url: 'u1', body: 'Old', createdAt: '2026-01-01', path: 'a.ts', line: 2, thread: outdated },
          { ...identity, id: 'n2', url: 'u2', body: 'Locked', createdAt: '2026-01-02', path: 'a.ts', line: 3, thread: denied },
        ],
        files: [],
      }),
    }), context, page.items[0]);
    expect(detail.comments[0]?.line).toBeNull();
    expect(detail.comments[0]?.thread).toMatchObject({ outdated: true, canResolve: true, canReply: true });
    expect(detail.comments[1]?.thread).toMatchObject({ canResolve: false, canReply: false });
  });

  test("carries the context's reviews, and leaves them out when the host does not send them", async () => {
    const page = await fetchListBackedReferencePage(reads(), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    const reviews = [
      { id: 'R1', state: 'approved' as const, author: { login: 'mona' }, submittedAt: null },
      { id: 'R2', state: 'dismissed' as const, author: { login: 'hubot' }, submittedAt: '2026-01-02T00:00:00Z' },
    ];
    const detail = await fetchListBackedReferenceDetail(reads({
      changeRequestContext: async () => ({ identity, project, changeRequest: mergeRequest, issueComments: [], reviewComments: [], files: [], reviews }),
    }), context, page.items[0]);
    expect(detail.pull?.reviews).toEqual(reviews);

    const silent = await fetchListBackedReferenceDetail(reads(), context, page.items[0]);
    expect('reviews' in (silent.pull ?? {})).toBe(false);
  });

  test('merge request rows carry their labels', async () => {
    const page = await fetchListBackedReferencePage(reads({
      changeRequestsList: async () => ({ items: [{ ...mergeRequest, labels: [{ name: 'bug', color: 'd73a4a' }] }], page: 1, hasMore: false }),
    }), context, provider, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page') throw new Error('expected a page');
    expect(page.items[0]?.labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
  });
});
