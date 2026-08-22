import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  GitHubAPI,
  GitHubIssueGetResult,
  GitHubPullRequestContextResult,
} from '@/lib/api/types';
import type { ForgeIssue, ForgePullRequest } from '@/lib/forge/types';

// GitHub issues have no merged state on the wire; `ForgeIssue` is broader.
type LiveIssue = Omit<ForgeIssue, 'state'> & { state: 'open' | 'closed' };

const fetchCalls: Array<{ kind: string; directory: string; number: number }> = [];
let issueResult: { connected: boolean; issue: LiveIssue | null } = { connected: true, issue: null };
let pullResult: { connected: boolean; pr: ForgePullRequest | null } = { connected: true, pr: null };
let fetchFailure: Error | null = null;
let apiPresent = true;
let registryAvailable = true;

// Minimal GitHub API double. `resolveLinkedEntityLive` goes through the real
// github adapter (`createGithubForgeProvider`), whose issue/PR lookups touch
// only `issueGet` and `prContext` on this surface — everything else is never
// reached. The module registry (`@/lib/forge/adapters`) is intentionally left
// untouched so the real provider factory is exercised exactly like `forge.test.ts`.
const fakeGithubApi = {
  issueGet: async (directory: string, number: number): Promise<GitHubIssueGetResult> => {
    fetchCalls.push({ kind: 'issue', directory, number });
    if (fetchFailure) throw fetchFailure;
    return {
      connected: issueResult.connected,
      repo: null,
      issue: issueResult.issue
        ? {
            number: issueResult.issue.number,
            title: issueResult.issue.title,
            url: '',
            state: issueResult.issue.state,
          }
        : null,
    };
  },
  prContext: async (directory: string, number: number): Promise<GitHubPullRequestContextResult> => {
    fetchCalls.push({ kind: 'pull', directory, number });
    if (fetchFailure) throw fetchFailure;
    return {
      connected: pullResult.connected,
      repo: null,
      pr: pullResult.pr
        ? {
            number: pullResult.pr.number,
            title: pullResult.pr.title,
            url: '',
            state: pullResult.pr.state,
            draft: pullResult.pr.draft,
            base: pullResult.pr.base?.ref ?? '',
            head: pullResult.pr.head?.ref ?? '',
          }
        : null,
      issueComments: [],
    };
  },
} as GitHubAPI;

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => {
    if (!registryAvailable) return null;
    return apiPresent ? { github: fakeGithubApi } : {};
  },
}));

const { linkedEntityLiveInvalidate, resolveLinkedEntityLive } = await import('./linkedEntityLive');

const githubEntry = () => ({
  id: 'owner/repo#12',
  number: 12,
  title: 'Rail badge count',
  url: 'https://github.com/owner/repo/issues/12',
  kind: 'issue' as const,
  provider: 'github' as const,
  linkedAt: 1,
});

const pullEntry = () => ({
  ...githubEntry(),
  id: 'owner/repo#7',
  number: 7,
  title: 'Fix',
  url: 'https://github.com/owner/repo/pull/7',
  kind: 'pull' as const,
});

// GitHub issues have no merged state on the wire; `ForgeIssue` is broader.
const issue = (state: 'open' | 'closed', title = 'Rail badge count'): LiveIssue => ({
  number: 12, title, state, labels: [], assignees: [],
});

const pr = (state: ForgePullRequest['state'], draft = false, title = 'Fix'): ForgePullRequest => ({
  number: 7, title, state, draft,
  base: { ref: 'main' }, head: { ref: 'feature' },
  labels: [], assignees: [],
});

describe('resolveLinkedEntityLive', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    issueResult = { connected: true, issue: null };
    pullResult = { connected: true, pr: null };
    fetchFailure = null;
    apiPresent = true;
    registryAvailable = true;
  });

  afterEach(() => {
    linkedEntityLiveInvalidate(githubEntry().id);
    linkedEntityLiveInvalidate(pullEntry().id);
  });

  test('resolves an issue to its live state and title', async () => {
    issueResult.issue = issue('open', 'Fresher title');

    const result = await resolveLinkedEntityLive(githubEntry(), '/repo');

    expect(result?.state).toBe('open');
    expect(result?.draft).toBe(false);
    expect(result?.title).toBe('Fresher title');
    expect(typeof result?.fetchedAt).toBe('number');
    expect(fetchCalls).toEqual([{ kind: 'issue', directory: '/repo', number: 12 }]);
  });

  test('resolves a pull request including its draft marker', async () => {
    pullResult.pr = pr('open', true, 'Draft: fix things');

    const result = await resolveLinkedEntityLive(pullEntry(), '/repo');

    expect(result?.state).toBe('open');
    expect(result?.draft).toBe(true);
    expect(result?.title).toBe('Draft: fix things');
    expect(typeof result?.fetchedAt).toBe('number');
    expect(fetchCalls).toEqual([{ kind: 'pull', directory: '/repo', number: 7 }]);
  });

  test('returns null without calling the facade when the entry has no resolvable id', async () => {
    const result = await resolveLinkedEntityLive(
      { ...githubEntry(), id: 'no-number' },
      '/repo',
    );
    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  test('returns null without calling the facade when the provider API is absent', async () => {
    registryAvailable = false;
    const result = await resolveLinkedEntityLive(githubEntry(), '/repo');
    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  test('returns null when buildForgeProvider yields no adapter', async () => {
    apiPresent = false;
    const result = await resolveLinkedEntityLive(githubEntry(), '/repo');
    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  test('returns null when the entity no longer resolves', async () => {
    issueResult.issue = null;
    const result = await resolveLinkedEntityLive(githubEntry(), '/repo');
    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(1);
  });

  test('never throws: a wire failure returns null and is cached', async () => {
    fetchFailure = new Error('boom');

    const first = await resolveLinkedEntityLive(githubEntry(), '/repo');
    expect(first).toBeNull();

    fetchFailure = null;
    issueResult.issue = issue('open');
    // The failed result is cached within the TTL, so no re-request happens.
    const second = await resolveLinkedEntityLive(githubEntry(), '/repo');
    expect(second).toBeNull();
    expect(fetchCalls).toHaveLength(1);
  });

  test('serves the second call from cache within the TTL window', async () => {
    issueResult.issue = issue('closed');

    const first = await resolveLinkedEntityLive(githubEntry(), '/repo');
    const second = await resolveLinkedEntityLive(githubEntry(), '/repo');

    expect(first?.state).toBe('closed');
    expect(second?.state).toBe('closed');
    expect(fetchCalls).toHaveLength(1);
  });

  test('linkedEntityLiveInvalidate forces a refetch', async () => {
    issueResult.issue = issue('open');

    await resolveLinkedEntityLive(githubEntry(), '/repo');
    linkedEntityLiveInvalidate(githubEntry().id);

    issueResult.issue = issue('closed');
    const after = await resolveLinkedEntityLive(githubEntry(), '/repo');

    expect(after?.state).toBe('closed');
    expect(fetchCalls).toHaveLength(2);
  });
});
