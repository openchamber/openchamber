import { describe, expect, test } from 'bun:test';
import type { ChangeRequest, ChangeRequestContext, Issue, SourceControlReadContext } from '@/lib/api/types';
import { fetchGitLabReferenceDetail, fetchGitLabReferencePage, pullReferenceFromChangeRequest } from './gitlabReferences';
import { DEFAULT_REPOSITORY_FILTER } from './referencePickerItems';
import { referenceNumberLabel, referencePickerItemKey } from './referencePickerItems';

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

const reads = (overrides: Partial<Parameters<typeof fetchGitLabReferencePage>[0]> = {}) => ({
  issuesList: async () => ({ items: [issue], page: 1, hasMore: true }),
  changeRequestsList: async () => ({ items: [mergeRequest], page: 2, hasMore: false }),
  issueComments: async () => [],
  changeRequestContext: async (): Promise<ChangeRequestContext> => ({ identity, project, changeRequest: mergeRequest, issueComments: [], reviewComments: [], files: [] }),
  issueGet: async (): Promise<Issue | null> => issue,
  ...overrides,
});

describe('GitLab references', () => {
  test('a page of issues reads as picker rows, closed as done, with the next page as cursor', async () => {
    const page = await fetchGitLabReferencePage(reads(), context, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page') throw new Error('expected a page');
    expect(page.items[0]).toMatchObject({ kind: 'issue', provider: 'gitlab', number: 3, state: 'completed', sourceRepo: { owner: 'group/sub', repo: 'app' } });
    expect(page.cursor).toBe('2');
    expect(referenceNumberLabel(page.items[0]!)).toBe('#3');
  });

  test('merge requests carry their branches and read as !N', async () => {
    const page = await fetchGitLabReferencePage(reads(), context, 'pull', DEFAULT_REPOSITORY_FILTER, 'fix', '2');
    if (page.kind !== 'page') throw new Error('expected a page');
    expect(page.items[0]).toMatchObject({ kind: 'pull', head: 'fix', base: 'main', headSha: 'abc' });
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
    expect(referenceNumberLabel(page.items[0]!)).toBe('!7');
  });

  test('issue #N and merge request !N select as different items', async () => {
    const issues = await fetchGitLabReferencePage(reads({ issuesList: async () => ({ items: [{ ...issue, number: 7 }], page: 1, hasMore: false }) }), context, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    const pulls = await fetchGitLabReferencePage(reads(), context, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (issues.kind !== 'page' || pulls.kind !== 'page') throw new Error('expected pages');
    const issueKey = referencePickerItemKey({ source: 'github', reference: issues.items[0]! });
    const pullKey = referencePickerItemKey({ source: 'github', reference: pulls.items[0]! });
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
    const byNumber = await fetchGitLabReferencePage(lookups, context, 'pull', DEFAULT_REPOSITORY_FILTER, '!7', null);
    if (byNumber.kind !== 'page') throw new Error('expected a page');
    expect(byNumber.items.map((item) => item.number)).toEqual([7]);
    expect(readNumber).toBe(7);

    await fetchGitLabReferencePage(lookups, context, 'pull', DEFAULT_REPOSITORY_FILTER, 'https://gitlab.com/group/sub/app/-/merge_requests/7', null);
    expect(readProject).toEqual({ owner: 'group/sub', name: 'app' });

    const issueByLink = await fetchGitLabReferencePage(lookups, context, 'issue', DEFAULT_REPOSITORY_FILTER, 'https://gitlab.com/group/sub/app/-/issues/3', null);
    if (issueByLink.kind !== 'page') throw new Error('expected a page');
    expect(issueByLink.items.map((item) => item.number)).toEqual([3]);

    await fetchGitLabReferencePage(lookups, context, 'pull', DEFAULT_REPOSITORY_FILTER, 'crash on save', null);
    expect(searched).toEqual(['crash on save']);
  });

  test('a page passes the state and whose items to GitLab', async () => {
    let seen: { state?: string; people?: string } | undefined;
    await fetchGitLabReferencePage(reads({ changeRequestsList: async (_context, options) => {
      seen = options;
      return { items: [], page: 1, hasMore: false };
    } }), context, 'pull', { state: 'merged', people: 'reviewRequested' }, '', null);
    expect(seen).toMatchObject({ page: 1, state: 'merged', people: 'reviewRequested' });
  });

  test('the preview reads a merge request through its context', async () => {
    const page = await fetchGitLabReferencePage(reads(), context, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page') throw new Error('expected a page');
    let askedCIDetails: boolean | undefined;
    const detail = await fetchGitLabReferenceDetail(reads({
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
  });

  test('a thread reads as its first note with the answers under it', async () => {
    const page = await fetchGitLabReferencePage(reads(), context, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    const thread = (first: boolean) => ({ id: 'abc', resolved: true, resolvable: true, first });
    const detail = await fetchGitLabReferenceDetail(reads({
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
    expect(detail.comments[0]?.thread).toMatchObject({ id: 'abc', resolved: true, canResolve: true, canReply: true, replies: [{ body: 'Done' }] });
  });

  test('the merge request comment total counts the merged thread it slices (#1820)', async () => {
    const page = await fetchGitLabReferencePage(reads(), context, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page' || !page.items[0]) throw new Error('expected a page');
    const note = (id: string, index: number, thread?: { id: string; resolved: boolean; resolvable: boolean; first: boolean }) => ({
      ...identity, id, url: `u-${id}`, body: id,
      createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      ...(thread ? { thread } : {}),
    });
    const detailFor = (issueComments: unknown[], reviewComments: unknown[], verdicts?: unknown[]) => fetchGitLabReferenceDetail(reads({
      changeRequestContext: async () => ({
        identity, project, changeRequest: mergeRequest,
        issueComments, reviewComments, files: [],
        ...(verdicts ? { verdicts } : {}),
      }) as ChangeRequestContext,
    }), context, page.items[0]!);

    // Mixed thread over the slice: 30 issue notes + 40 review notes merge
    // to 70, of which the newest 50 are shown - the total is the merged 70,
    // not the 30 raw issue notes.
    const mixed = await detailFor(
      Array.from({ length: 30 }, (_, i) => note(`issue-${i}`, i)),
      Array.from({ length: 40 }, (_, i) => note(`review-${i}`, 30 + i)),
    );
    expect(mixed.comments).toHaveLength(50);
    expect(mixed.commentTotal).toBe(70);

    // Threaded replies fold under their openers: 30 openers + 50 replies
    // are a 30-entry thread, so the total is 30, not the 80 raw notes.
    const openers = Array.from({ length: 30 }, (_, i) => note(`opener-${i}`, i, { id: `t${i}`, resolved: false, resolvable: true, first: true }));
    const replies = Array.from({ length: 50 }, (_, i) => note(`reply-${i}`, 30 + i, { id: `t${i % 30}`, resolved: false, resolvable: true, first: false }));
    const threaded = await detailFor(openers, replies);
    expect(threaded.comments).toHaveLength(30);
    expect(threaded.commentTotal).toBe(30);

    // A verdict is a thread entry too: 1 + 1 + verdict totals 3.
    const withVerdict = await detailFor(
      [note('issue-0', 0)],
      [note('review-0', 1)],
      [{ state: 'approved', createdAt: '2026-01-02', url: 'v' }],
    );
    expect(withVerdict.comments).toHaveLength(3);
    expect(withVerdict.commentTotal).toBe(3);

    // Control: 60 flat issue notes on a merge request still total 60.
    const flat = await detailFor(Array.from({ length: 60 }, (_, i) => note(`flat-${i}`, i)), []);
    expect(flat.comments).toHaveLength(50);
    expect(flat.commentTotal).toBe(60);
  });

  test('merge request rows carry their labels', async () => {
    const page = await fetchGitLabReferencePage(reads({
      changeRequestsList: async () => ({ items: [{ ...mergeRequest, labels: [{ name: 'bug', color: 'd73a4a' }] }], page: 1, hasMore: false }),
    }), context, 'pull', DEFAULT_REPOSITORY_FILTER, '', null);
    if (page.kind !== 'page') throw new Error('expected a page');
    expect(page.items[0]?.labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
  });
  test('a body clamp never splits a surrogate pair (oracle: astral char straddling offset 20,000 drops its high half, ASCII control cuts at exactly 20,000)', async () => {
    const straddle = 'a'.repeat(19_999) + '\u{1F600}' + 'tail';
    const issuePage = await fetchGitLabReferencePage(reads({ issuesList: async () => ({ items: [{ ...issue, body: straddle }], page: 1, hasMore: false }) }), context, 'issue', DEFAULT_REPOSITORY_FILTER, '', null);
    if (issuePage.kind !== 'page') throw new Error('expected a page');
    const issueBody = (issuePage.items[0] as { body: string; bodyTruncated: boolean }).body;
    expect(issueBody).toBe('a'.repeat(19_999));
    expect((issuePage.items[0] as { bodyTruncated: boolean }).bodyTruncated).toBe(true);
    const pullBody = pullReferenceFromChangeRequest({ ...mergeRequest, body: straddle }).body;
    expect(pullBody).toBe('a'.repeat(19_999));
    expect(pullReferenceFromChangeRequest({ ...mergeRequest, body: straddle }).bodyTruncated).toBe(true);
    for (const value of [issueBody, pullBody]) {
      expect(new TextDecoder().decode(new TextEncoder().encode(value))).not.toContain('\uFFFD');
    }
    // ASCII control still cuts at exactly the limit.
    const ascii = pullReferenceFromChangeRequest({ ...mergeRequest, body: 'a'.repeat(25_000) });
    expect(ascii.body).toBe('a'.repeat(20_000));
    expect(ascii.bodyTruncated).toBe(true);
  });
});

