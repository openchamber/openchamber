import { beforeEach, describe, expect, test } from 'bun:test';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { useGitProviderDomainsStore } from '@/stores/useGitProviderDomainsStore';
import type { ForgeRepoRef } from '@/lib/forge/types';
import type { LinkedIssue } from '@/lib/linkedIssues';
import {
  findLinkedSessionsForEntity,
  linkedEntityCandidateIds,
  type LinkedSessionCandidate,
} from './linkedSessionMatches';

const resetStores = () => {
  useGitProviderDomainsStore.setState({
    domains: { github: [], gitlab: [], gitea: [] },
    apiBaseUrls: { github: '', gitlab: '', gitea: '' },
  });
  useGiteaAuthStore.setState({ status: null });
  useGitLabAuthStore.setState({ status: null });
};

const repoRef = (overrides: Partial<ForgeRepoRef> = {}): ForgeRepoRef => ({
  owner: 'owner',
  repo: 'widget',
  provider: 'github',
  ...overrides,
});

const linkedIssue = (overrides: Partial<LinkedIssue> = {}): LinkedIssue => ({
  id: 'owner/widget#42',
  number: 42,
  title: 'Rail badge count',
  url: 'https://github.com/owner/widget/pull/42',
  kind: 'pull',
  author: 'someone',
  linkedAt: 100,
  ...overrides,
});

const session = (
  overrides: Partial<Pick<LinkedSessionCandidate, 'id' | 'title'>> & { linked?: unknown } = {},
): LinkedSessionCandidate => ({
  id: overrides.id ?? 'ses_1',
  title: overrides.title ?? 'Fix the rail',
  metadata: { openchamber: { linked_issues: overrides.linked ?? [] } },
});

describe('linkedEntityCandidateIds', () => {
  test('github uses the flat owner/repo id', () => {
    expect(linkedEntityCandidateIds(repoRef({ provider: 'github' }), 42)).toEqual([
      'owner/widget#42',
    ]);
  });

  test('gitea uses the flat owner/repo id', () => {
    expect(linkedEntityCandidateIds(repoRef({ provider: 'gitea' }), 42)).toEqual([
      'owner/widget#42',
    ]);
  });

  test('gitlab with a single-segment namespace uses the flat id only', () => {
    expect(linkedEntityCandidateIds(repoRef({ provider: 'gitlab', owner: 'acme', repo: 'proj' }), 9)).toEqual([
      'acme/proj#9',
    ]);
  });

  test('gitlab with a multi-segment namespace also includes the full project path', () => {
    expect(
      linkedEntityCandidateIds(repoRef({ provider: 'gitlab', owner: 'acme', namespace: 'group/sub', repo: 'proj' }), 9),
    ).toEqual(['acme/proj#9', 'group/sub/proj#9']);
  });

  test('gitlab where the namespace equals the owner produces one candidate', () => {
    expect(
      linkedEntityCandidateIds(repoRef({ provider: 'gitlab', owner: 'group', namespace: 'group', repo: 'proj' }), 9),
    ).toEqual(['group/proj#9']);
  });
});

describe('findLinkedSessionsForEntity', () => {
  beforeEach(resetStores);

  test('returns an empty list when nothing matches', () => {
    const sessions = [
      session({ id: 'ses_a', linked: [linkedIssue({ id: 'other/repo#7', number: 7 })] }),
      session({ id: 'ses_b' }),
    ];
    expect(findLinkedSessionsForEntity(sessions, 'github', ['owner/widget#42'])).toEqual([]);
  });

  test('matches a session whose stored entry id is the entity', () => {
    const sessions = [session({ id: 'ses_a', linked: [linkedIssue()] })];
    expect(findLinkedSessionsForEntity(sessions, 'github', ['owner/widget#42'])).toEqual([
      { sessionId: 'ses_a', title: 'Fix the rail', linkedAt: 100 },
    ]);
  });

  test('matches a legacy entry without a provider field by deriving it from the url', () => {
    const legacy = linkedIssue({
      id: 'owner/widget#42',
      url: 'https://github.com/owner/widget/pull/42',
      provider: undefined,
    });
    const sessions = [session({ id: 'ses_a', linked: [legacy] })];
    expect(findLinkedSessionsForEntity(sessions, 'github', ['owner/widget#42'])).toEqual([
      { sessionId: 'ses_a', title: 'Fix the rail', linkedAt: 100 },
    ]);
  });

  test('rejects an entry whose provider differs from the viewed entity', () => {
    const gitlabEntry = linkedIssue({
      id: 'owner/widget#42',
      url: 'https://gitlab.com/owner/widget/-/issues/42',
      provider: 'gitlab',
    });
    const sessions = [session({ id: 'ses_a', linked: [gitlabEntry] })];
    // Same id, but the session linked a gitlab entity while this view is github.
    expect(findLinkedSessionsForEntity(sessions, 'github', ['owner/widget#42'])).toEqual([]);
  });

  test('matches by id alone when no provider can be derived', () => {
    // Fallback ids embed the full url and cannot be resolved to a provider.
    const unknown = linkedIssue({
      id: 'https://ghe.internal/x#3',
      number: 3,
      url: 'https://ghe.internal/x',
    });
    const sessions = [session({ id: 'ses_a', linked: [unknown] })];
    expect(findLinkedSessionsForEntity(sessions, 'github', ['https://ghe.internal/x#3'])).toEqual([
      { sessionId: 'ses_a', title: 'Fix the rail', linkedAt: 100 },
    ]);
  });

  test('matches the gitlab namespace candidate when the stored id uses the full project path', () => {
    const entry = linkedIssue({
      id: 'group/sub/proj#9',
      number: 9,
      url: 'https://gitlab.com/group/sub/proj/-/issues/9',
      provider: 'gitlab',
    });
    const sessions = [session({ id: 'ses_a', linked: [entry] })];
    const candidates = linkedEntityCandidateIds(
      repoRef({ provider: 'gitlab', owner: 'acme', namespace: 'group/sub', repo: 'proj' }),
      9,
    );
    expect(candidates).toEqual(['acme/proj#9', 'group/sub/proj#9']);
    expect(findLinkedSessionsForEntity(sessions, 'gitlab', candidates)).toEqual([
      { sessionId: 'ses_a', title: 'Fix the rail', linkedAt: 100 },
    ]);
  });

  test('dedupes a session that holds both the flat and the namespaced candidate, keeping the newest linkedAt', () => {
    const entries = [
      linkedIssue({
        id: 'acme/proj#9',
        number: 9,
        url: 'https://gitlab.com/acme/proj/-/issues/9',
        provider: 'gitlab',
        linkedAt: 10,
      }),
      linkedIssue({
        id: 'group/sub/proj#9',
        number: 9,
        url: 'https://gitlab.com/group/sub/proj/-/issues/9',
        provider: 'gitlab',
        linkedAt: 40,
      }),
    ];
    const sessions = [session({ id: 'ses_a', linked: entries })];
    const candidates = linkedEntityCandidateIds(
      repoRef({ provider: 'gitlab', owner: 'acme', namespace: 'group/sub', repo: 'proj' }),
      9,
    );
    expect(findLinkedSessionsForEntity(sessions, 'gitlab', candidates)).toEqual([
      { sessionId: 'ses_a', title: 'Fix the rail', linkedAt: 40 },
    ]);
  });

  test('sorts by linkedAt descending, then by title', () => {
    const sessions = [
      session({ id: 'ses_old', title: 'Old chat', linked: [linkedIssue({ linkedAt: 10 })] }),
      session({ id: 'ses_new', title: 'New chat', linked: [linkedIssue({ linkedAt: 50 })] }),
      // Same linkedAt as ses_old; title decides the order.
      session({ id: 'ses_tie', title: 'A tie', linked: [linkedIssue({ linkedAt: 10 })] }),
    ];
    expect(findLinkedSessionsForEntity(sessions, 'github', ['owner/widget#42']).map((row) => row.sessionId))
      .toEqual(['ses_new', 'ses_tie', 'ses_old']);
  });

  test('skips sessions with no metadata and malformed entries', () => {
    const sessions = [
      session({ id: 'ses_empty' }),
      session({ id: 'ses_malformed', linked: [{ id: 'owner/widget#42' }] }),
      { id: 'ses_no_title', metadata: { openchamber: { linked_issues: [linkedIssue()] } } },
    ];
    expect(findLinkedSessionsForEntity(sessions, 'github', ['owner/widget#42'])).toEqual([
      { sessionId: 'ses_no_title', title: '', linkedAt: 100 },
    ]);
  });
});
