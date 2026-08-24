import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { useGitProviderDomainsStore } from '@/stores/useGitProviderDomainsStore';
import {
  buildLinkedIssue,
  buildLinkedIssueId,
  deriveLinkedIssueProvider,
  deriveLinkedIssueRepo,
  getLinkedIssues,
  parseForgeEntityUrl,
  parseLinkedIssueRef,
  withLinkedIssue,
  type LinkedIssue,
} from './linkedIssues';

const issue = (overrides: Partial<LinkedIssue> = {}): LinkedIssue => ({
  id: 'owner/repo#12',
  number: 12,
  title: 'Rail badge count',
  url: 'https://github.com/owner/repo/issues/12',
  kind: 'issue',
  author: 'someone',
  linkedAt: 1,
  ...overrides,
});

const sessionWith = (linked: unknown): Session =>
  ({ metadata: { openchamber: { linked_issues: linked } } } as unknown as Session);

const resetStores = () => {
  useGitProviderDomainsStore.setState({
    domains: { github: [], gitlab: [], gitea: [] },
    apiBaseUrls: { github: '', gitlab: '', gitea: '' },
  });
  useGiteaAuthStore.setState({ status: null });
  useGitLabAuthStore.setState({ status: null });
};

describe('buildLinkedIssueId', () => {
  test('is stable per repository and number', () => {
    expect(buildLinkedIssueId('owner', 'repo', 12)).toBe('owner/repo#12');
  });
});

describe('buildLinkedIssue', () => {
  beforeEach(resetStores);

  test('derives the id from the thread url', () => {
    const built = buildLinkedIssue({
      url: 'https://github.com/owner/repo/issues/12',
      number: 12,
      title: 'Rail badge count',
      kind: 'issue',
      author: { login: 'someone', avatarUrl: 'https://avatars/1' },
      linkedAt: 5,
    });
    expect(built.id).toBe('owner/repo#12');
    expect(built.author).toBe('someone');
    expect(built.authorAvatarUrl).toBe('https://avatars/1');
  });

  test('gives a pull request the same id shape as an issue', () => {
    // Both live in one numbering space per repository, so one id shape keeps
    // them from colliding or duplicating.
    const built = buildLinkedIssue({
      url: 'https://github.com/owner/repo/pull/7',
      number: 7,
      title: 'Fix',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(built.id).toBe('owner/repo#7');
    expect(built.kind).toBe('pull');
  });

  test('parses GitLab issue urls with nested namespaces on any host', () => {
    const built = buildLinkedIssue({
      url: 'https://gitlab.example.com/a/b/project/-/issues/5',
      number: 5,
      title: 'Nested issue',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(built.id).toBe('a/b/project#5');
  });

  test('parses GitLab merge request urls, including legacy non-/- paths', () => {
    const modern = buildLinkedIssue({
      url: 'https://gitlab.com/owner/repo/-/merge_requests/7',
      number: 7,
      title: 'Modern MR',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(modern.id).toBe('owner/repo#7');

    const legacy = buildLinkedIssue({
      url: 'https://gitlab.example.com/owner/repo/merge_requests/9',
      number: 9,
      title: 'Legacy MR',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(legacy.id).toBe('owner/repo#9');
  });

  test('builds a stable gitea id for pull and issue urls (regression fix)', () => {
    // Gitea/Forgejo urls are `https://host/owner/repo/pulls/N` or
    // `/issues/N` with no `/-/` segment. Before the fix, the `/pulls/` form
    // fell through to the raw-url fallback id and could never be matched.
    const pulls = buildLinkedIssue({
      url: 'https://git.example.com/owner/repo/pulls/5',
      number: 5,
      title: 'Gitea PR',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(pulls.id).toBe('owner/repo#5');

    const issues = buildLinkedIssue({
      url: 'https://git.example.com/owner/repo/issues/5',
      number: 5,
      title: 'Gitea issue',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(issues.id).toBe('owner/repo#5');

    // Forgejo shares the flat owner/repo + /pulls/ shape.
    const forgejo = buildLinkedIssue({
      url: 'https://codeberg.example/org/repo/pulls/7',
      number: 7,
      title: 'Forgejo PR',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(forgejo.id).toBe('org/repo#7');
  });

  test('keeps a github.com /pulls/ url on the github id shape', () => {
    const built = buildLinkedIssue({
      url: 'https://github.com/owner/repo/pulls/5',
      number: 5,
      title: 'Plural pulls',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(built.id).toBe('owner/repo#5');
  });

  test('falls back to a url-based id for an unparseable url', () => {
    const built = buildLinkedIssue({
      url: 'https://ghe.internal/x',
      number: 3,
      title: 'Internal',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(built.id).toBe('https://ghe.internal/x#3');
  });

  test('omits author fields when the flow has none', () => {
    const built = buildLinkedIssue({
      url: 'https://github.com/owner/repo/issues/1',
      number: 1,
      title: 'No author',
      kind: 'issue',
      author: null,
      linkedAt: 5,
    });
    expect(built.author).toBe(undefined);
    expect(built.authorAvatarUrl).toBe(undefined);
  });

  test('records provider, repo and host for a github.com link', () => {
    const built = buildLinkedIssue({
      url: 'https://github.com/owner/repo/issues/12',
      number: 12,
      title: 'Rail badge count',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(built.provider).toBe('github');
    expect(built.repo).toBe('owner/repo');
    expect(built.host).toBe('github.com');
  });

  test('records provider, repo and host for a gitlab.com link', () => {
    const built = buildLinkedIssue({
      url: 'https://gitlab.com/group/project/-/issues/5',
      number: 5,
      title: 'Group issue',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(built.provider).toBe('gitlab');
    expect(built.repo).toBe('group/project');
    expect(built.host).toBe('gitlab.com');
  });

  test('records provider, repo and host for a gitea.com link', () => {
    const built = buildLinkedIssue({
      url: 'https://gitea.com/owner/repo/pulls/5',
      number: 5,
      title: 'Gitea PR',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(built.provider).toBe('gitea');
    expect(built.repo).toBe('owner/repo');
    expect(built.host).toBe('gitea.com');
  });

  test('derives provider and repo for a self-hosted gitea link from the domains store', () => {
    useGitProviderDomainsStore.setState({
      domains: { github: [], gitlab: [], gitea: ['git.example.com'] },
    });
    const built = buildLinkedIssue({
      url: 'https://git.example.com/owner/repo/pulls/5',
      number: 5,
      title: 'Gitea PR',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(built.provider).toBe('gitea');
    expect(built.repo).toBe('owner/repo');
    expect(built.host).toBe('git.example.com');
  });

  test('omits identity fields when nothing can be derived', () => {
    const built = buildLinkedIssue({
      url: 'https://ghe.internal/x',
      number: 3,
      title: 'Internal',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(built.provider).toBe(undefined);
    expect(built.repo).toBe(undefined);
    expect(built.host).toBe('ghe.internal');
  });

  test('respects explicit provider, repo and host overrides', () => {
    const built = buildLinkedIssue({
      url: 'https://github.com/owner/repo/issues/5',
      number: 5,
      title: 'Overridden',
      kind: 'issue',
      linkedAt: 5,
      provider: 'gitlab',
      repo: 'custom/path',
      host: 'mirror.example.com',
    });
    // The id stays url-driven; only the identity fields are overridden.
    expect(built.id).toBe('owner/repo#5');
    expect(built.provider).toBe('gitlab');
    expect(built.repo).toBe('custom/path');
    expect(built.host).toBe('mirror.example.com');
  });
});

describe('deriveLinkedIssueProvider', () => {
  beforeEach(resetStores);

  test('recognizes the well-known hosts', () => {
    expect(deriveLinkedIssueProvider('https://github.com/owner/repo/issues/1')).toBe('github');
    expect(deriveLinkedIssueProvider('https://gitlab.com/a/b/project/-/issues/2')).toBe('gitlab');
    expect(deriveLinkedIssueProvider('https://gitea.com/owner/repo/pulls/3')).toBe('gitea');
  });

  test('derives a self-hosted gitea host from the domains store', () => {
    useGitProviderDomainsStore.setState({
      domains: { github: [], gitlab: [], gitea: ['git.example.com'] },
    });
    expect(deriveLinkedIssueProvider('https://git.example.com/owner/repo/pulls/5')).toBe('gitea');
  });

  test('derives a self-hosted github host from the configured api base url', () => {
    useGitProviderDomainsStore.setState({
      domains: { github: [], gitlab: [], gitea: [] },
      apiBaseUrls: { github: 'https://github.example.com/api/v3', gitlab: '', gitea: '' },
    });
    expect(deriveLinkedIssueProvider('https://github.example.com/owner/repo/issues/1')).toBe('github');
  });

  test('derives a self-hosted gitlab host from the domains store', () => {
    useGitProviderDomainsStore.setState({
      domains: { github: [], gitlab: ['gitlab.example.com'], gitea: [] },
    });
    expect(deriveLinkedIssueProvider('https://gitlab.example.com/group/project/-/issues/5')).toBe('gitlab');
  });

  test('derives a self-hosted gitea host from an auth account base url', () => {
    useGiteaAuthStore.setState({
      status: {
        connected: true,
        accounts: [
          { id: '1', user: { username: 'someone' }, baseUrl: 'https://gitea.example.com', current: true },
        ],
      },
    });
    expect(deriveLinkedIssueProvider('https://gitea.example.com/org/repo/pulls/3')).toBe('gitea');
  });

  test('derives a self-hosted gitlab host from an auth account base url', () => {
    useGitLabAuthStore.setState({
      status: {
        connected: true,
        accounts: [
          { id: '1', user: { username: 'someone' }, baseUrl: 'https://gitlab.example.com', current: true },
        ],
        defaultBaseUrl: 'https://gitlab.example.com',
      },
    });
    expect(deriveLinkedIssueProvider('https://gitlab.example.com/a/b/project/-/issues/5')).toBe('gitlab');
  });

  test('github wins over a configured gitea host (github.com never becomes gitea)', () => {
    useGitProviderDomainsStore.setState({
      domains: { github: [], gitlab: [], gitea: ['github.com', 'gitea.example.com'] },
    });
    expect(deriveLinkedIssueProvider('https://github.com/owner/repo/issues/1')).toBe('github');
  });

  test('returns null for an unknown host without configuration', () => {
    expect(deriveLinkedIssueProvider('https://internal.example/owner/repo/issues/3')).toBeNull();
    expect(deriveLinkedIssueProvider('not a url')).toBeNull();
  });
});

describe('deriveLinkedIssueRepo', () => {
  test('returns the project path portion of the stable id', () => {
    expect(deriveLinkedIssueRepo('https://github.com/owner/repo/issues/12', 12)).toBe('owner/repo');
    expect(deriveLinkedIssueRepo('https://gitlab.com/a/b/project/-/issues/5', 5)).toBe('a/b/project');
    expect(deriveLinkedIssueRepo('https://git.example.com/owner/repo/pulls/5', 5)).toBe('owner/repo');
    expect(deriveLinkedIssueRepo('https://gitea.com/owner/repo/issues/3', 3)).toBe('owner/repo');
  });

  test('returns null for an unparseable url', () => {
    expect(deriveLinkedIssueRepo('https://ghe.internal/x', 3)).toBeNull();
  });
});

describe('parseLinkedIssueRef', () => {
  beforeEach(resetStores);

  test('parses a github entry', () => {
    const ref = parseLinkedIssueRef(issue());
    expect(ref).toEqual({ provider: 'github', owner: 'owner', repo: 'repo', number: 12 });
  });

  test('parses a github pull entry', () => {
    const ref = parseLinkedIssueRef({
      id: 'owner/repo#7',
      number: 7,
      title: 'Fix',
      url: 'https://github.com/owner/repo/pull/7',
      kind: 'pull',
      provider: 'github',
      linkedAt: 1,
    });
    expect(ref).toEqual({ provider: 'github', owner: 'owner', repo: 'repo', number: 7 });
  });

  test('parses a gitlab entry with a multi-segment namespace via the provider field', () => {
    const ref = parseLinkedIssueRef({
      id: 'a/b/project#5',
      number: 5,
      title: 'Nested',
      url: 'https://gitlab.example.com/a/b/project/-/issues/5',
      kind: 'issue',
      provider: 'gitlab',
      linkedAt: 1,
    });
    expect(ref).toEqual({
      provider: 'gitlab',
      owner: 'a',
      namespace: 'a/b',
      repo: 'project',
      number: 5,
    });
  });

  test('parses a gitlab entry with a flat namespace', () => {
    const ref = parseLinkedIssueRef({
      id: 'group/project#9',
      number: 9,
      title: 'Flat',
      url: 'https://gitlab.com/group/project/-/issues/9',
      kind: 'issue',
      provider: 'gitlab',
      linkedAt: 1,
    });
    expect(ref).toEqual({
      provider: 'gitlab',
      owner: 'group',
      namespace: 'group',
      repo: 'project',
      number: 9,
    });
  });

  test('parses a gitea entry', () => {
    const ref = parseLinkedIssueRef({
      id: 'owner/repo#5',
      number: 5,
      title: 'Gitea PR',
      url: 'https://git.example.com/owner/repo/pulls/5',
      kind: 'pull',
      provider: 'gitea',
      linkedAt: 1,
    });
    expect(ref).toEqual({ provider: 'gitea', owner: 'owner', repo: 'repo', number: 5 });
  });

  test('derives github for a legacy snapshot without a provider field', () => {
    const ref = parseLinkedIssueRef({
      id: 'owner/repo#7',
      number: 7,
      title: 'Legacy',
      url: 'https://github.com/owner/repo/pull/7',
      kind: 'pull',
      linkedAt: 1,
    });
    expect(ref).toEqual({ provider: 'github', owner: 'owner', repo: 'repo', number: 7 });
  });

  test('derives gitlab for a legacy snapshot with a nested id on a known host', () => {
    const ref = parseLinkedIssueRef({
      id: 'a/b/project#5',
      number: 5,
      title: 'Nested legacy',
      url: 'https://gitlab.com/a/b/project/-/issues/5',
      kind: 'issue',
      linkedAt: 1,
    });
    expect(ref).toEqual({
      provider: 'gitlab',
      owner: 'a',
      namespace: 'a/b',
      repo: 'project',
      number: 5,
    });
  });

  test('infers gitlab-style from a multi-segment id when no provider is derivable', () => {
    const ref = parseLinkedIssueRef({
      id: 'a/b/c#5',
      number: 5,
      title: 'Unknown host',
      url: 'https://unknown.example/a/b/c/issues/5',
      kind: 'issue',
      linkedAt: 1,
    });
    expect(ref).toEqual({ provider: 'gitlab', owner: 'a', namespace: 'a/b', repo: 'c', number: 5 });
  });

  test('infers github-style from a flat id when no provider is derivable', () => {
    const ref = parseLinkedIssueRef({
      id: 'owner/repo#5',
      number: 5,
      title: 'Unknown host',
      url: 'https://unknown.example/owner/repo/issues/5',
      kind: 'issue',
      linkedAt: 1,
    });
    expect(ref).toEqual({ provider: 'github', owner: 'owner', repo: 'repo', number: 5 });
  });

  test('round-trips a github link through buildLinkedIssue', () => {
    const built = buildLinkedIssue({
      url: 'https://github.com/owner/repo/issues/12',
      number: 12,
      title: 'Rail badge count',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(parseLinkedIssueRef(built)).toEqual({
      provider: 'github',
      owner: 'owner',
      repo: 'repo',
      number: 12,
    });
  });

  test('round-trips a gitlab link through buildLinkedIssue', () => {
    const built = buildLinkedIssue({
      url: 'https://gitlab.com/a/b/project/-/issues/5',
      number: 5,
      title: 'Nested',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(parseLinkedIssueRef(built)).toEqual({
      provider: 'gitlab',
      owner: 'a',
      namespace: 'a/b',
      repo: 'project',
      number: 5,
    });
  });

  test('round-trips a gitea link through buildLinkedIssue', () => {
    useGitProviderDomainsStore.setState({
      domains: { github: [], gitlab: [], gitea: ['git.example.com'] },
    });
    const built = buildLinkedIssue({
      url: 'https://git.example.com/owner/repo/pulls/5',
      number: 5,
      title: 'Gitea PR',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(parseLinkedIssueRef(built)).toEqual({
      provider: 'gitea',
      owner: 'owner',
      repo: 'repo',
      number: 5,
    });
  });

  test('returns null for malformed ids', () => {
    const base = {
      number: 1,
      title: 'x',
      url: 'https://github.com/o/r/issues/1',
      kind: 'issue' as const,
      linkedAt: 1,
    };
    expect(parseLinkedIssueRef({ ...base, id: 'no-number' })).toBeNull();
    expect(parseLinkedIssueRef({ ...base, id: 'owner/repo#' })).toBeNull();
    expect(parseLinkedIssueRef({ ...base, id: 'repo#1' })).toBeNull();
    expect(parseLinkedIssueRef({ ...base, id: 'owner#notanumber' })).toBeNull();
    // Fallback ids embed the full url and cannot be resolved.
    expect(parseLinkedIssueRef({ ...base, id: 'https://ghe.internal/x#3' })).toBeNull();
  });
});

describe('parseForgeEntityUrl', () => {
  beforeEach(resetStores);

  test('parses a github issue url', () => {
    expect(parseForgeEntityUrl('https://github.com/owner/repo/issues/12')).toEqual({
      provider: 'github',
      repo: 'owner/repo',
      number: 12,
      kind: 'issue',
    });
  });

  test('parses github pull urls in singular and plural', () => {
    expect(parseForgeEntityUrl('https://github.com/owner/repo/pull/7')).toEqual({
      provider: 'github', repo: 'owner/repo', number: 7, kind: 'pull',
    });
    expect(parseForgeEntityUrl('https://github.com/owner/repo/pulls/7')).toEqual({
      provider: 'github', repo: 'owner/repo', number: 7, kind: 'pull',
    });
  });

  test('parses a gitlab issue url with nested namespaces and the -/ segment', () => {
    expect(parseForgeEntityUrl('https://gitlab.com/a/b/project/-/issues/5')).toEqual({
      provider: 'gitlab',
      repo: 'a/b/project',
      number: 5,
      kind: 'issue',
    });
  });

  test('parses a gitlab merge request url, including the legacy non-/- path', () => {
    expect(parseForgeEntityUrl('https://gitlab.com/group/project/-/merge_requests/9')).toEqual({
      provider: 'gitlab', repo: 'group/project', number: 9, kind: 'pull',
    });
    expect(parseForgeEntityUrl('https://gitlab.com/group/project/merge_requests/9')).toEqual({
      provider: 'gitlab', repo: 'group/project', number: 9, kind: 'pull',
    });
  });

  test('parses a gitea pulls url on a configured host', () => {
    useGitProviderDomainsStore.setState({
      domains: { github: [], gitlab: [], gitea: ['git.example.com'] },
    });
    expect(parseForgeEntityUrl('https://git.example.com/owner/repo/pulls/5')).toEqual({
      provider: 'gitea', repo: 'owner/repo', number: 5, kind: 'pull',
    });
  });

  test('ignores query strings, fragments and trailing slashes', () => {
    expect(parseForgeEntityUrl('https://github.com/owner/repo/issues/12?ref=main#comments')).toEqual({
      provider: 'github', repo: 'owner/repo', number: 12, kind: 'issue',
    });
    expect(parseForgeEntityUrl('https://github.com/owner/repo/issues/12/')).toEqual({
      provider: 'github', repo: 'owner/repo', number: 12, kind: 'issue',
    });
  });

  test('round-trips through buildLinkedIssue', () => {
    const parsed = parseForgeEntityUrl('https://github.com/owner/repo/pull/7');
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const built = buildLinkedIssue({
      url: 'https://github.com/owner/repo/pull/7',
      number: parsed.number,
      title: 'Fix',
      kind: parsed.kind,
      provider: parsed.provider,
      repo: parsed.repo,
      linkedAt: 5,
    });
    expect(built.id).toBe('owner/repo#7');
    expect(parseLinkedIssueRef(built)).toEqual({
      provider: 'github', owner: 'owner', repo: 'repo', number: 7,
    });
  });

  test('returns null for urls without an entity segment or number', () => {
    expect(parseForgeEntityUrl('https://github.com/owner/repo')).toBeNull();
    expect(parseForgeEntityUrl('https://github.com/owner/repo/issues')).toBeNull();
    expect(parseForgeEntityUrl('https://github.com/owner/repo/issues/')).toBeNull();
    expect(parseForgeEntityUrl('https://github.com/owner/repo/issues/abc')).toBeNull();
  });

  test('returns null for a host the provider cannot be derived from', () => {
    expect(parseForgeEntityUrl('https://internal.example/owner/repo/issues/3')).toBeNull();
  });

  test('returns null for non-URLs and incomplete paths', () => {
    expect(parseForgeEntityUrl('not a url')).toBeNull();
    expect(parseForgeEntityUrl('https://github.com/repo/issues/3')).toBeNull();
    expect(parseForgeEntityUrl('')).toBeNull();
  });
});

describe('getLinkedIssues', () => {
  test('returns an empty list for a session with no metadata', () => {
    expect(getLinkedIssues(undefined)).toEqual([]);
    expect(getLinkedIssues({} as Session)).toEqual([]);
    expect(getLinkedIssues(sessionWith(undefined))).toEqual([]);
  });

  test('drops malformed entries instead of rendering them', () => {
    const good = issue();
    const session = sessionWith([
      good,
      { id: 'no-number' },
      { ...good, id: 'owner/repo#13', kind: 'discussion' },
      null,
      'string',
    ]);
    expect(getLinkedIssues(session)).toEqual([good]);
  });

  test('survives a non-array payload', () => {
    expect(getLinkedIssues(sessionWith({ nope: true }))).toEqual([]);
  });

  test('keeps old snapshots with the new optional identity fields', () => {
    // A snapshot recorded after the upgrade carries provider/repo/host; the
    // previous shape (without them) must stay valid too.
    const oldStyle = issue({ id: 'owner/repo#12' });
    const newStyle = {
      ...issue({ id: 'owner/repo#13', number: 13 }),
      provider: 'github',
      repo: 'owner/repo',
      host: 'github.com',
    };
    expect(getLinkedIssues(sessionWith([oldStyle, newStyle]))).toEqual([oldStyle, newStyle]);
  });
});

describe('withLinkedIssue', () => {
  test('adds a link and preserves unrelated metadata', () => {
    const next = withLinkedIssue(
      { openchamber: { kind: 'review' }, other: 1 },
      issue(),
      true,
    );
    expect(next.other).toBe(1);
    expect((next.openchamber as Record<string, unknown>).kind).toBe('review');
    expect((next.openchamber as { linked_issues: LinkedIssue[] }).linked_issues).toEqual([issue()]);
  });

  test('re-linking replaces the entry rather than duplicating it', () => {
    // Linking again is how a drifted title gets refreshed.
    const first = withLinkedIssue({}, issue({ title: 'Old' }), true);
    const second = withLinkedIssue(first, issue({ title: 'New' }), true);
    const stored = (second.openchamber as { linked_issues: LinkedIssue[] }).linked_issues;
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('New');
  });

  test('unlinking removes only the matching id', () => {
    const other = issue({ id: 'owner/repo#99', number: 99 });
    const both = withLinkedIssue(withLinkedIssue({}, issue(), true), other, true);
    const next = withLinkedIssue(both, issue(), false);
    const stored = (next.openchamber as { linked_issues: LinkedIssue[] }).linked_issues;
    expect(stored).toEqual([other]);
  });

  test('unlinking something absent is a no-op, not an error', () => {
    const next = withLinkedIssue({}, issue(), false);
    expect((next.openchamber as { linked_issues: LinkedIssue[] }).linked_issues).toEqual([]);
  });

  test('does not carry malformed stored entries forward', () => {
    const next = withLinkedIssue(
      { openchamber: { linked_issues: [{ id: 'broken' }] } },
      issue(),
      true,
    );
    expect((next.openchamber as { linked_issues: LinkedIssue[] }).linked_issues).toEqual([issue()]);
  });
});
