import { describe, expect, test } from 'bun:test';

import type {
  RepositoryChangeRequestReference,
  ChangeRequestListStatus,
  RepositoryReferencesAcrossResult,
  RepositoryReferenceQuery,
  SourceControlReadContext,
} from '@/lib/api/types';

import {
  NO_ACROSS_CONTEXTS,
  ensurePullStatuses,
  fetchAcrossPage,
  groupPullsByDirectory,
  itemDirectory,
  leftOutFolders,
  partitionAcrossContexts,
  pullStatusKey,
  skippedOf,
} from './acrossRepositories';
import { createValueCache } from './referenceCache';
import { githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';

const across = { referencesAcross: true, listStatuses: true };
const githubLike = githubLikeDescriptor();
const descriptors = [
  { ...githubLike, features: { ...githubLike.features, ...across } },
  gitlabLikeDescriptor(),
];

const context = (directory: string, provider: 'github' | 'gitlab' = 'github'): SourceControlReadContext => ({
  provider,
  instance: provider === 'github' ? 'github.com' : 'gitlab.com',
  accountId: 'account',
  directory,
  repositoryId: `repo:${directory}`,
  primaryRemote: 'origin',
  bindingRevision: 1,
});

const pull = (repo: string, number: number, state: 'open' | 'closed' = 'open'): RepositoryChangeRequestReference => ({
  kind: 'pull', provider: 'github', number, title: `PR ${number}`, url: `https://github.com/acme/${repo}/pull/${number}`,
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo, source: 'origin' },
  state, draft: false, head: `branch-${number}`, base: 'main', headSha: `sha-${number}`, headRepo: null,
});

describe('partitionAcrossContexts', () => {
  test('asks the folders of the provider that searches across repositories, and names the others, in folder order', () => {
    const result = partitionAcrossContexts([
      { directory: '/w/a', state: context('/w/a') },
      { directory: '/w/b', state: context('/w/b', 'gitlab') },
      { directory: '/w/c', state: 'missing' },
      { directory: '/w/d', state: context('/w/d') },
    ], descriptors);
    expect(result.ready).toBe(true);
    expect(result.provider).toBe('github');
    expect(result.asked.map((entry) => entry.directory)).toEqual(['/w/a', '/w/d']);
    expect(result.excluded).toEqual([
      { directory: '/w/b', reason: 'unsupportedProvider', provider: 'gitlab' },
      { directory: '/w/c', reason: 'missing' },
    ]);
  });

  test('asks the lowest-order provider among those present that can search across repositories', () => {
    const gitlab = gitlabLikeDescriptor();
    const searchingGitLab = [githubLikeDescriptor(), { ...gitlab, features: { ...gitlab.features, ...across } }];
    const folders = [
      { directory: '/w/a', state: context('/w/a') },
      { directory: '/w/b', state: context('/w/b', 'gitlab') },
    ];
    const result = partitionAcrossContexts(folders, searchingGitLab);
    expect(result.provider).toBe('gitlab');
    expect(result.asked.map((entry) => entry.directory)).toEqual(['/w/b']);
    expect(result.excluded).toEqual([{ directory: '/w/a', reason: 'unsupportedProvider', provider: 'github' }]);
    // No provider present can search: nothing is asked.
    expect(partitionAcrossContexts(folders, [githubLikeDescriptor()])).toMatchObject({ provider: null, asked: [] });
  });

  test('is not ready while any folder still loads', () => {
    const result = partitionAcrossContexts([{ directory: '/w/a', state: context('/w/a') }, { directory: '/w/b', state: null }], descriptors);
    expect(result.ready).toBe(false);
    expect(result.asked.map((entry) => entry.directory)).toEqual(['/w/a']);
  });
});

describe('what a list leaves out', () => {
  test('joins the folders never asked with those the answer skipped', () => {
    const contexts = partitionAcrossContexts([{ directory: '/w/a', state: 'missing' }], descriptors);
    const skipped = skippedOf([
      { directory: '/w/b', status: 'included', repo: { owner: 'acme', repo: 'b', url: '' } },
      { directory: '/w/c', status: 'error' },
      { directory: '/w/d', status: 'disconnected' },
    ]);
    expect(skipped).toEqual([{ directory: '/w/c', reason: 'error' }, { directory: '/w/d', reason: 'disconnected' }]);
    expect(leftOutFolders(contexts, skipped).map((entry) => `${entry.directory}:${entry.reason}`))
      .toEqual(['/w/a:missing', '/w/c:error', '/w/d:disconnected']);
    expect(leftOutFolders(NO_ACROSS_CONTEXTS, [])).toEqual([]);
  });
});

describe('fetchAcrossPage', () => {
  const github = [{ directory: '/w/a', context: context('/w/a') }, { directory: '/w/b', context: context('/w/b') }];
  const result = (overrides: Partial<RepositoryReferencesAcrossResult>): RepositoryReferencesAcrossResult => ({
    items: [], cursor: null, hasMore: false, total: 0, repositories: [], ...overrides,
  });

  test('sends one request with the contexts of the asked folders, the filter and the cursor', async () => {
    const calls: Array<{ contexts: SourceControlReadContext[]; options: RepositoryReferenceQuery }> = [];
    const page = await fetchAcrossPage(async (contexts, options) => {
      calls.push({ contexts, options });
      return result({ items: [{ ...pull('a', 1), directory: '/w/a' }], cursor: 'next', hasMore: true, repositories: [{ directory: '/w/a', status: 'included', repo: { owner: 'acme', repo: 'a', url: '' } }, { directory: '/w/b', status: 'no-repo' }] });
    }, github, { kind: 'pull', state: 'open', people: 'any', query: '#1', cursor: 'c1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.contexts.map((entry) => entry.directory)).toEqual(['/w/a', '/w/b']);
    expect(calls[0]?.options).toEqual({ kind: 'pull', state: 'open', people: 'any', query: '#1', cursor: 'c1' });
    expect(page).toMatchObject({ kind: 'page', cursor: 'next', hasMore: true, skipped: [{ directory: '/w/b', reason: 'no-repo' }] });
  });

  test('asks nothing without an asked folder or where the runtime cannot', async () => {
    let asked = 0;
    const search = async () => { asked += 1; return result({}); };
    expect(await fetchAcrossPage(search, [], { kind: 'issue' })).toEqual({ kind: 'unavailable', reason: 'no-repo' });
    expect(await fetchAcrossPage(undefined, github, { kind: 'issue' })).toEqual({ kind: 'unavailable', reason: 'no-repo' });
    expect(asked).toBe(0);
  });

  test('reads as disconnected when no folder has an account, and fails when the request does', async () => {
    const page = await fetchAcrossPage(async () => result({ repositories: [{ directory: '/w/a', status: 'disconnected' }, { directory: '/w/b', status: 'disconnected' }] }), github, { kind: 'issue' });
    expect(page).toEqual({ kind: 'unavailable', reason: 'disconnected' });
    await expect(fetchAcrossPage(async () => { throw new Error('rate limited'); }, github, { kind: 'issue' })).rejects.toThrow('rate limited');
  });

  test('fails when no folder was read and one of them failed, so a failure never reads as an empty list', async () => {
    const failed = async () => result({ repositories: [{ directory: '/w/a', status: 'error' }, { directory: '/w/b', status: 'disconnected' }] });
    await expect(fetchAcrossPage(failed, github, { kind: 'issue' })).rejects.toThrow();
    const invalid = async () => result({ repositories: [{ directory: '/w/a', status: 'invalid-context' }, { directory: '/w/b', status: 'no-repo' }] });
    await expect(fetchAcrossPage(invalid, github, { kind: 'issue' })).rejects.toThrow();
    const nothing = async () => result({ repositories: [{ directory: '/w/a', status: 'no-repo' }, { directory: '/w/b', status: 'disconnected' }] });
    expect(await fetchAcrossPage(nothing, github, { kind: 'issue' })).toEqual({ kind: 'unavailable', reason: 'disconnected' });
    await expect(fetchAcrossPage(nothing, github, { kind: 'issue', cursor: 'page-2' })).rejects.toThrow();
    const noRepo = async () => result({ repositories: [{ directory: '/w/a', status: 'no-repo' }, { directory: '/w/b', status: 'no-repo' }] });
    expect(await fetchAcrossPage(noRepo, github, { kind: 'issue' })).toEqual({ kind: 'unavailable', reason: 'no-repo' });
  });

  test('lists what was read and reports a failed folder beside it', async () => {
    const page = await fetchAcrossPage(async () => result({
      items: [{ ...pull('a', 1), directory: '/w/a' }],
      repositories: [{ directory: '/w/a', status: 'included', repo: { owner: 'acme', repo: 'a', url: '' } }, { directory: '/w/b', status: 'error' }],
    }), github, { kind: 'pull' });
    expect(page).toMatchObject({ kind: 'page', skipped: [{ directory: '/w/b', reason: 'error' }] });
  });
});

describe('an item finds its folder', () => {
  test('uses its own directory across repositories, else the list\'s', () => {
    expect(itemDirectory({ source: 'repository', reference: pull('a', 1), directory: '/w/a' }, '/w')).toBe('/w/a');
    expect(itemDirectory({ source: 'repository', reference: pull('a', 1) }, '/w/a')).toBe('/w/a');
    expect(itemDirectory({ source: 'repository', reference: pull('a', 1) }, null)).toBeNull();
    expect(itemDirectory(null, '/w')).toBe('/w');
  });
});

describe('pull statuses across repositories', () => {
  const contexts = partitionAcrossContexts([
    { directory: '/w/a', state: context('/w/a') },
    { directory: '/w/b', state: context('/w/b') },
    { directory: '/w/c', state: context('/w/c', 'gitlab') },
  ], descriptors);

  test('groups the open PRs of each folder with that folder\'s context', () => {
    const groups = groupPullsByDirectory([
      { reference: pull('a', 1), directory: '/w/a' },
      { reference: pull('b', 2), directory: '/w/b' },
      { reference: pull('a', 3, 'closed'), directory: '/w/a' },
      { reference: pull('a', 4), directory: '/w/a' },
      { reference: pull('c', 5), directory: '/w/c' },
    ], contexts.asked);
    expect(groups.map((group) => [group.directory, group.context.directory, group.pulls.map((entry) => entry.number)]))
      .toEqual([['/w/a', '/w/a', [1, 4]], ['/w/b', '/w/b', [2]]]);
  });

  test('asks each group through its own context in batches, and one failing leaves the others', async () => {
    const cache = createValueCache<ChangeRequestListStatus | null>(50);
    const groups = groupPullsByDirectory([
      { reference: pull('a', 1), directory: '/w/a' },
      { reference: pull('a', 2), directory: '/w/a' },
      { reference: pull('a', 3), directory: '/w/a' },
      { reference: pull('b', 7), directory: '/w/b' },
    ], contexts.asked);
    const asked: Array<[string, number[]]> = [];
    ensurePullStatuses(cache, groups, (group) => group.directory, async (askedContext, pulls) => {
      asked.push([askedContext.directory, pulls.map((entry) => entry.number)]);
      if (askedContext.directory === '/w/b') throw new Error('rate limited');
      return {
        connected: true,
        statuses: pulls.map((entry) => ({
          owner: 'acme', repo: entry.sourceRepo.repo, number: entry.number,
          checks: { state: 'success', total: 1, success: 1, failure: 0, pending: 0 }, mergeable: true, mergeableState: 'clean',
        })),
      };
    }, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual([['/w/a', [1, 2]], ['/w/a', [3]], ['/w/b', [7]]]);
    const keyOf = (directory: string, repo: string, number: number) => pullStatusKey(directory, pull(repo, number));
    expect(cache.read(keyOf('/w/a', 'a', 1))?.status).toBe('ready');
    expect(cache.read(keyOf('/w/a', 'a', 3))?.status).toBe('ready');
    expect(cache.read(keyOf('/w/b', 'b', 7))).toEqual({ status: 'error', error: 'rate limited' });
  });
});
