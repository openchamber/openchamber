import { describe, expect, test } from 'bun:test';
import type { ChangeRequest, ChangeRequestContext, Issue, SourceControlReadContext } from '@/lib/api/types';
import { fetchGitLabReferenceDetail, fetchGitLabReferencePage } from './gitlabReferences';
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
  ...overrides,
});

describe('GitLab references', () => {
  test('a page of issues reads as picker rows, closed as done, with the next page as cursor', async () => {
    const page = await fetchGitLabReferencePage(reads(), context, 'issue', '', null);
    if (page.kind !== 'page') throw new Error('expected a page');
    expect(page.items[0]).toMatchObject({ kind: 'issue', provider: 'gitlab', number: 3, state: 'completed', sourceRepo: { owner: 'group/sub', repo: 'app' } });
    expect(page.cursor).toBe('2');
    expect(referenceNumberLabel(page.items[0]!)).toBe('#3');
  });

  test('merge requests carry their branches and read as !N', async () => {
    const page = await fetchGitLabReferencePage(reads(), context, 'pull', 'fix', '2');
    if (page.kind !== 'page') throw new Error('expected a page');
    expect(page.items[0]).toMatchObject({ kind: 'pull', head: 'fix', base: 'main', headSha: 'abc' });
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
    expect(referenceNumberLabel(page.items[0]!)).toBe('!7');
  });

  test('issue #N and merge request !N select as different items', async () => {
    const issues = await fetchGitLabReferencePage(reads({ issuesList: async () => ({ items: [{ ...issue, number: 7 }], page: 1, hasMore: false }) }), context, 'issue', '', null);
    const pulls = await fetchGitLabReferencePage(reads(), context, 'pull', '', null);
    if (issues.kind !== 'page' || pulls.kind !== 'page') throw new Error('expected pages');
    const issueKey = referencePickerItemKey({ source: 'github', reference: issues.items[0]! });
    const pullKey = referencePickerItemKey({ source: 'github', reference: pulls.items[0]! });
    expect(issueKey).toBe('gitlab:group/sub/app#7');
    expect(pullKey).toBe('gitlab:group/sub/app!7');
  });

  test('the preview reads a merge request through its context', async () => {
    const page = await fetchGitLabReferencePage(reads(), context, 'pull', '', null);
    if (page.kind !== 'page') throw new Error('expected a page');
    const detail = await fetchGitLabReferenceDetail(reads({
      changeRequestContext: async () => ({
        identity, project, changeRequest: mergeRequest,
        issueComments: [{ ...identity, id: 'c1', url: 'u', body: 'later', createdAt: '2026-02-01' }],
        reviewComments: [{ ...identity, id: 'c2', url: 'u2', body: 'earlier', createdAt: '2026-01-01', path: 'a.ts', line: 4 }],
        files: [{ path: 'a.ts', additions: 3, deletions: 1 }, { path: 'b.ts', additions: 2 }],
        ci: { summary: { state: 'success', total: 1, success: 1, failure: 0, pending: 0 } },
      }),
    }), context, page.items[0]!);
    expect(detail.comments.map((comment) => comment.body)).toEqual(['earlier', 'later']);
    expect(detail.comments[0]).toMatchObject({ path: 'a.ts', line: 4 });
    expect(detail.pull).toMatchObject({ additions: 5, deletions: 1, changedFiles: 2, checks: { state: 'success' } });
  });
});
