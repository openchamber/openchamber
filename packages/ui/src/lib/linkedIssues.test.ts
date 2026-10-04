import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionMetadataRecord } from './sessionReviewMetadata';
import { buildLinkedGuestIssue, buildLinkedIssue, buildLinkedIssueId, buildLinkedLinearIssue, canOpenLinearIssueInContextPanel, getDistinctLinkedIssues, getGitLabThreadRef, getLinkedGitHubPullRequests, getLinkedGitLabThreads, getLinkedIssues, getLinkedSidebarChanges, getLinkedSidebarIssues, withLinkedIssue, type LinkedIssue } from './linkedIssues';

type LinkedRepositoryIssue = Extract<LinkedIssue, { kind: 'issue' | 'pull' }>;

const issue = (overrides: Partial<LinkedRepositoryIssue> = {}): LinkedRepositoryIssue => ({
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

describe('buildLinkedIssueId', () => {
  test('is stable per repository and number', () => {
    expect(buildLinkedIssueId('owner', 'repo', 12)).toBe('owner/repo#12');
  });
});

describe('buildLinkedIssue', () => {
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

  test('derives the id from a GitLab issue with nested groups', () => {
    const built = buildLinkedIssue({
      url: 'https://gitlab.example.com/platform/tools/repo/-/issues/9',
      number: 9,
      title: 'Fix',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(built.id).toBe('gitlab.example.com:platform/tools/repo#9');
  });

  test('keeps the same path on different instances apart', () => {
    const github = buildLinkedIssue({ url: 'https://github.com/team/repo/issues/12', number: 12, title: 'A', kind: 'issue', linkedAt: 1 });
    const gitlab = buildLinkedIssue({ url: 'https://gitlab.com/team/repo/-/issues/12', number: 12, title: 'B', kind: 'issue', linkedAt: 2 });
    const selfManaged = buildLinkedIssue({ url: 'https://git.example.com/team/repo/-/issues/12', number: 12, title: 'C', kind: 'issue', linkedAt: 3 });
    const metadata = [github, gitlab, selfManaged].reduce<SessionMetadataRecord>((current, issue) => withLinkedIssue(current, issue, true), {});
    // SAFETY: withLinkedIssue always writes openchamber.linked_issues as a LinkedIssue array.
    expect((metadata.openchamber as { linked_issues: LinkedIssue[] }).linked_issues.map((entry) => entry.title)).toEqual(['A', 'B', 'C']);
  });

  test('re-linking a GitLab thread stored before ids carried the host replaces it', () => {
    const legacy = { ...buildLinkedIssue({ url: 'https://gitlab.com/team/repo/-/issues/12', number: 12, title: 'Old', kind: 'issue', linkedAt: 1 }), id: 'team/repo#12' };
    const fresh = buildLinkedIssue({ url: 'https://gitlab.com/team/repo/-/issues/12', number: 12, title: 'New', kind: 'issue', linkedAt: 2 });
    const metadata = withLinkedIssue({ openchamber: { linked_issues: [legacy] } }, fresh, true);
    // SAFETY: withLinkedIssue always writes openchamber.linked_issues as a LinkedIssue array.
    expect((metadata.openchamber as { linked_issues: LinkedIssue[] }).linked_issues.map((entry) => entry.title)).toEqual(['New']);
  });

  test('keeps GitLab merge requests distinct from issues with the same number', () => {
    const built = buildLinkedIssue({
      url: 'https://gitlab.example.com/platform/tools/repo/-/merge_requests/9',
      number: 9,
      title: 'Fix',
      kind: 'pull',
      linkedAt: 5,
    });
    expect(built.id).toBe('https://gitlab.example.com/platform/tools/repo/-/merge_requests/9#9');
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

  test('falls back without throwing for a malformed url', () => {
    const built = buildLinkedIssue({
      url: 'not a url',
      number: 3,
      title: 'Internal',
      kind: 'issue',
      linkedAt: 5,
    });
    expect(built.id).toBe('not a url#3');
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
});

describe('buildLinkedLinearIssue', () => {
  test('stores the Linear identifier without inventing a GitHub number', () => {
    const built = buildLinkedLinearIssue({
      identifier: 'ENG-12',
      title: 'Broken login',
      url: 'https://linear.app/openchamber/issue/ENG-12',
      author: { login: 'Ada', avatarUrl: 'https://avatars/1' },
      linkedAt: 5,
    });
    expect(built).toEqual({
      id: 'linear:ENG-12',
      identifier: 'ENG-12',
      title: 'Broken login',
      url: 'https://linear.app/openchamber/issue/ENG-12',
      kind: 'linear',
      author: 'Ada',
      authorAvatarUrl: 'https://avatars/1',
      linkedAt: 5,
    });
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

  test('keeps a guest entry without inventing a number', () => {
    const guest = buildLinkedGuestIssue({
      providerId: 'hello',
      identifier: 'HELLO-1',
      title: 'Sample ticket',
      url: 'https://example.com/HELLO-1',
      linkedAt: 3,
    });
    expect(guest.kind).toBe('guest');
    expect(guest.thread).toBe('issue');
    expect(guest.id).toBe('guest:hello:HELLO-1');
    expect(getLinkedIssues(sessionWith([guest]))).toEqual([guest]);
  });

  test('keeps the opaque guest data through the snapshot round trip', () => {
    const data = { status: 'open', comments: [{ author: 'mara', text: 'hi' }], count: 2, ok: true, none: null };
    const guest = buildLinkedGuestIssue({
      providerId: 'hello',
      identifier: 'HELLO-1',
      title: 'Sample ticket',
      url: 'https://example.com/HELLO-1',
      data,
      linkedAt: 3,
    });
    expect(guest.data).toEqual(data);
    // SAFETY: a JSON round trip of a session fixture is the same session shape the
    // metadata channel hands back; the guard under test re-checks every field.
    const stored = JSON.parse(JSON.stringify(sessionWith([guest]))) as Parameters<typeof getLinkedIssues>[0];
    expect(getLinkedIssues(stored)).toEqual([guest]);
    const restored = getLinkedIssues(stored)[0];
    expect(restored?.kind === 'guest' ? restored.data : undefined).toEqual(data);
  });

  test('keeps a guest pull with author and branches', () => {
    const guest = buildLinkedGuestIssue({
      providerId: 'gitlab',
      identifier: '!12',
      title: 'Fix login',
      url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      thread: 'pull',
      author: 'ada',
      head: 'feature',
      base: 'main',
      linkedAt: 4,
    });
    expect(guest.thread).toBe('pull');
    expect(guest.author).toBe('ada');
    expect(guest.head).toBe('feature');
    expect(guest.base).toBe('main');
    expect(getLinkedIssues(sessionWith([guest]))).toEqual([guest]);
  });

  test('treats a stored guest row without thread as an issue', () => {
    const stored = {
      id: 'guest:hello:HELLO-1',
      providerId: 'hello',
      identifier: 'HELLO-1',
      title: 'Sample ticket',
      url: 'https://example.com/HELLO-1',
      kind: 'guest',
      linkedAt: 3,
    };
    expect(getLinkedIssues(sessionWith([stored]))).toEqual([stored]);
  });

  test('keeps Linear entries next to GitHub ones', () => {
    const github = issue();
    const linear = buildLinkedLinearIssue({
      identifier: 'ENG-12',
      title: 'Broken login',
      url: 'https://linear.app/openchamber/issue/ENG-12',
      linkedAt: 2,
    });
    expect(getLinkedIssues(sessionWith([github, linear]))).toEqual([github, linear]);
  });

  test('survives a non-array payload', () => {
    expect(getLinkedIssues(sessionWith({ nope: true }))).toEqual([]);
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

describe('canOpenLinearIssueInContextPanel', () => {
  test('opens the rail when Linear is connected, the shell has a context panel, and a directory is known', () => {
    expect(canOpenLinearIssueInContextPanel({
      linearAvailable: true,
      linearConnected: true,
      inDedicatedMobileShell: false,
      directory: '/repo',
    })).toBe(true);
  });

  test('falls back when Linear is missing, disconnected, the mobile shell is open, or the directory is blank', () => {
    expect(canOpenLinearIssueInContextPanel({
      linearAvailable: false,
      linearConnected: true,
      inDedicatedMobileShell: false,
      directory: '/repo',
    })).toBe(false);
    expect(canOpenLinearIssueInContextPanel({
      linearAvailable: true,
      linearConnected: false,
      inDedicatedMobileShell: false,
      directory: '/repo',
    })).toBe(false);
    expect(canOpenLinearIssueInContextPanel({
      linearAvailable: true,
      linearConnected: true,
      inDedicatedMobileShell: true,
      directory: '/repo',
    })).toBe(false);
    expect(canOpenLinearIssueInContextPanel({
      linearAvailable: true,
      linearConnected: true,
      inDedicatedMobileShell: false,
      directory: '  ',
    })).toBe(false);
  });
});

describe('getLinkedGitHubPullRequests', () => {
  test('reads the repository of each linked GitHub PR from its id', () => {
    const session = sessionWith([
      issue(),
      issue({ id: 'acme/app#7', number: 7, kind: 'pull', title: 'Fix', url: 'https://github.com/acme/app/pull/7' }),
      { id: 'linear:ENG-1', identifier: 'ENG-1', title: 'Linear', url: 'https://linear.app/x', kind: 'linear', linkedAt: 1 },
    ]);
    expect(getLinkedGitHubPullRequests(session)).toEqual([
      { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Fix' },
    ]);
  });

  test('skips a PR whose id could not name its repository', () => {
    const session = sessionWith([
      issue({ id: 'https://ghe.example/acme/app/pull/7#7', number: 7, kind: 'pull', url: 'https://ghe.example/acme/app/pull/7' }),
    ]);
    expect(getLinkedGitHubPullRequests(session)).toEqual([]);
  });
});

describe('getLinkedSidebarIssues', () => {
  test('lists GitHub issues with their repository and trackers by identifier, never pull requests', () => {
    const session = sessionWith([
      issue(),
      issue({ id: 'acme/app#7', number: 7, kind: 'pull', url: 'https://github.com/acme/app/pull/7' }),
      { id: 'linear:ENG-1', identifier: 'ENG-1', title: 'Linear task', url: 'https://linear.app/x', kind: 'linear', linkedAt: 1 },
      { id: 'guest:jira:OPS-2', providerId: 'jira', identifier: 'OPS-2', title: 'Ops', url: 'https://jira/x', kind: 'guest', thread: 'issue', linkedAt: 1 },
      { id: 'guest:gitea:5', providerId: 'gitea', identifier: '5', title: 'Guest PR', url: 'https://gitea/x', kind: 'guest', thread: 'pull', linkedAt: 1 },
    ]);
    expect(getLinkedSidebarIssues(session)).toEqual([
      { source: 'github', key: 'owner/repo#12', owner: 'owner', repo: 'repo', number: 12, url: 'https://github.com/owner/repo/issues/12', title: 'Rail badge count' },
      { source: 'linear', key: 'linear:ENG-1', identifier: 'ENG-1', url: 'https://linear.app/x', title: 'Linear task' },
      { source: 'guest', key: 'guest:jira:OPS-2', identifier: 'OPS-2', url: 'https://jira/x', title: 'Ops' },
    ]);
  });

  test('an agent-linked external issue is listed by identifier; its merge request is not an issue', () => {
    const session = sessionWith([
      { id: 'link:https://jira.example/OPS-7', kind: 'external', thread: 'issue', identifier: 'OPS-7', title: 'Outage', url: 'https://jira.example/OPS-7', linkedAt: 1 },
      { id: 'link:https://gitlab.com/a/b/-/merge_requests/42', kind: 'external', thread: 'change', identifier: '!42', title: 'Fix', url: 'https://gitlab.com/a/b/-/merge_requests/42', linkedAt: 1 },
      { id: 'link:broken', kind: 'external', thread: 'pull', identifier: 'x', title: 'Bad', url: 'u', linkedAt: 1 },
    ]);
    expect(getLinkedIssues(session).map((entry) => entry.id)).toEqual([
      'link:https://jira.example/OPS-7',
      'link:https://gitlab.com/a/b/-/merge_requests/42',
    ]);
    expect(getLinkedSidebarIssues(session)).toEqual([
      { source: 'external', key: 'link:https://jira.example/OPS-7', identifier: 'OPS-7', url: 'https://jira.example/OPS-7', title: 'Outage' },
    ]);
  });
});

describe('links to github.com from extensions and agents', () => {
  test('count as the GitHub thread: looked up, and listed once', () => {
    const session = sessionWith([
      issue({ id: 'acme/app#7', number: 7, kind: 'pull', url: 'https://github.com/acme/app/pull/7' }),
      { id: 'guest:gh:7', providerId: 'gh', identifier: '7', title: 'Same PR', url: 'https://github.com/acme/app/pull/7', kind: 'guest', thread: 'pull', linkedAt: 1 },
      { id: 'guest:gh:8', providerId: 'gh', identifier: '8', title: 'Other PR', url: 'https://github.com/acme/app/pull/8', kind: 'guest', thread: 'pull', linkedAt: 1 },
      { id: 'link:https://github.com/acme/app/issues/9', kind: 'external', thread: 'issue', identifier: 'github.com', title: 'Bug', url: 'https://github.com/acme/app/issues/9', linkedAt: 1 },
      issue({ id: 'acme/app#9', number: 9, kind: 'issue', url: 'https://github.com/acme/app/issues/9' }),
    ]);
    expect(getLinkedGitHubPullRequests(session).map((pr) => pr.number)).toEqual([7, 8]);
    expect(getLinkedSidebarChanges(session)).toEqual([]);
    expect(getDistinctLinkedIssues(session).map((entry) => entry.id)).toEqual([
      'acme/app#7', 'guest:gh:8', 'link:https://github.com/acme/app/issues/9',
    ]);
    expect(getLinkedSidebarIssues(session)).toEqual([
      { source: 'github', key: 'acme/app#9', owner: 'acme', repo: 'app', number: 9, url: 'https://github.com/acme/app/issues/9', title: 'Bug' },
    ]);
  });
});

describe('getLinkedSidebarChanges', () => {
  test('lists merge and pull requests from other services, never GitHub ones or issues', () => {
    const session = sessionWith([
      issue({ id: 'acme/app#7', number: 7, kind: 'pull', url: 'https://github.com/acme/app/pull/7' }),
      { id: 'guest:gitea:5', providerId: 'gitea', identifier: '5', title: 'Guest PR', url: 'https://gitea/x', kind: 'guest', thread: 'pull', linkedAt: 1 },
      { id: 'link:https://gitlab.com/a/b/-/merge_requests/42', kind: 'external', thread: 'change', identifier: '!42', title: 'Fix', url: 'https://gitlab.com/a/b/-/merge_requests/42', linkedAt: 1 },
      { id: 'link:https://jira.example/OPS-7', kind: 'external', thread: 'issue', identifier: 'OPS-7', title: 'Outage', url: 'https://jira.example/OPS-7', linkedAt: 1 },
    ]);
    expect(getLinkedSidebarChanges(session)).toEqual([
      { key: 'guest:gitea:5', identifier: '5', url: 'https://gitea/x', title: 'Guest PR' },
      {
        key: 'link:https://gitlab.com/a/b/-/merge_requests/42', identifier: '!42', url: 'https://gitlab.com/a/b/-/merge_requests/42', title: 'Fix',
        gitlab: { key: 'https://gitlab.com/a/b!42', instance: 'https://gitlab.com', owner: 'a', repo: 'b', number: 42, thread: 'pull' },
      },
    ]);
  });
});

describe('GitLab threads', () => {
  test('reads the instance, subgroup path and number from the address, and leaves GitHub alone', () => {
    const mergeRequest = issue({ id: 'https://gitlab.example.com/g/sub/app/-/merge_requests/3#3', number: 3, kind: 'pull', url: 'https://gitlab.example.com/g/sub/app/-/merge_requests/3' });
    expect(getGitLabThreadRef(mergeRequest)).toEqual({
      key: 'https://gitlab.example.com/g/sub/app!3', instance: 'https://gitlab.example.com', owner: 'g/sub', repo: 'app', number: 3, thread: 'pull',
    });
    const gitlabIssue = issue({ id: 'gitlab.com:team/app#8', number: 8, kind: 'issue', url: 'https://gitlab.com/team/app/-/issues/8' });
    expect(getGitLabThreadRef(gitlabIssue)).toMatchObject({ owner: 'team', repo: 'app', number: 8, thread: 'issue' });
    expect(getGitLabThreadRef(issue({ id: 'acme/app#7', number: 7, kind: 'pull', url: 'https://github.com/acme/app/pull/7' }))).toBeNull();
    expect(getGitLabThreadRef(issue({ id: 'x', number: 1, kind: 'issue', url: 'https://example.com/not/a/thread' }))).toBeNull();
  });

  test('lists each linked merge request and issue once and gives sidebar issues their thread', () => {
    const url = 'https://gitlab.com/team/app/-/issues/8';
    const session = sessionWith([
      issue({ id: 'gitlab.com:team/app#8', number: 8, kind: 'issue', url }),
      { id: `link:${url}`, kind: 'external', thread: 'issue', identifier: '#8', title: 'Same issue', url, linkedAt: 2 },
      issue({ id: 'mr', number: 3, kind: 'pull', url: 'https://gitlab.com/team/app/-/merge_requests/3' }),
    ]);
    expect(getLinkedGitLabThreads(session).map((ref) => ref.key)).toEqual(['https://gitlab.com/team/app#8', 'https://gitlab.com/team/app!3']);
    expect(getLinkedSidebarIssues(session)).toMatchObject([
      { source: 'gitlab', identifier: '#8', ref: { number: 8, thread: 'issue' } },
    ]);
  });
});
