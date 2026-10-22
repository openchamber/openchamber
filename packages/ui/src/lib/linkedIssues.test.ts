import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionMetadataRecord } from './sessionReviewMetadata';
import { buildLinkedGuestIssue, buildLinkedIssue, buildLinkedIssueId, buildLinkedTrackerItem, getDistinctLinkedIssues, toStoredLinkedIssue, getLinkedIssues, getLinkedSidebarChanges, getLinkedSidebarIssues, getRepositoryThreadRef, withLinkedIssue, type LinkedIssue } from './linkedIssues';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from './source-control/providers/descriptor.fixture';
import { createRepositoryUrlMatcher } from './source-control/repositoryUrlMatcher';
import { repositoryThread } from './trackedItems/fromLinks';
import { trackedItemKey } from './trackedItems/model';

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

describe('buildLinkedTrackerItem', () => {
  test('stores the tracker and its identifier without inventing a GitHub number', () => {
    const built = buildLinkedTrackerItem({
      provider: 'linear',
      identifier: 'ENG-12',
      title: 'Broken login',
      url: 'https://linear.app/openchamber/issue/ENG-12',
      author: { login: 'Ada', avatarUrl: 'https://avatars/1' },
      linkedAt: 5,
    });
    expect(built).toEqual({
      id: 'linear:ENG-12',
      kind: 'tracker',
      provider: 'linear',
      identifier: 'ENG-12',
      title: 'Broken login',
      url: 'https://linear.app/openchamber/issue/ENG-12',
      author: 'Ada',
      authorAvatarUrl: 'https://avatars/1',
      linkedAt: 5,
    });
  });
});

describe('toStoredLinkedIssue', () => {
  // Clients from before trackers read only `kind: 'linear'` and rewrite the
  // list without entries they cannot read; a Linear link stays one they keep.
  test('stores a Linear link as `linear` with its provider, another tracker as `tracker`, and reads both back', () => {
    const linear = buildLinkedTrackerItem({ provider: 'linear', identifier: 'ENG-12', title: 'Broken login', url: 'https://linear.app/openchamber/issue/ENG-12', linkedAt: 5 });
    const acme = buildLinkedTrackerItem({ provider: 'acme-tickets', identifier: 'OPS-7', title: 'Pager', url: 'https://acme.example/OPS-7', linkedAt: 6 });
    expect(toStoredLinkedIssue(linear)).toEqual({ ...linear, kind: 'linear', provider: 'linear' });
    expect(toStoredLinkedIssue(acme)).toEqual(acme);
    expect(toStoredLinkedIssue(issue())).toEqual(issue());

    const metadata = [linear, acme].reduce<SessionMetadataRecord>((current, entry) => withLinkedIssue(current, entry, true), {});
    expect(storedIssues(metadata).map((entry): string => entry.kind)).toEqual(['linear', 'tracker']);
    expect(getLinkedIssues(sessionWith([toStoredLinkedIssue(linear), toStoredLinkedIssue(acme)]))).toEqual([linear, acme]);
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

  test('keeps tracker entries next to GitHub ones', () => {
    const github = issue();
    const linear = buildLinkedTrackerItem({
      provider: 'linear',
      identifier: 'ENG-12',
      title: 'Broken login',
      url: 'https://linear.app/openchamber/issue/ENG-12',
      linkedAt: 2,
    });
    expect(getLinkedIssues(sessionWith([github, linear]))).toEqual([github, linear]);
  });

  test('reads a Linear entry stored before trackers had their own kind as a Linear tracker item', () => {
    const stored = { id: 'linear:ENG-12', identifier: 'ENG-12', title: 'Broken login', url: 'https://linear.app/openchamber/issue/ENG-12', kind: 'linear', linkedAt: 2 };
    expect(getLinkedIssues(sessionWith([stored]))).toEqual([{ ...stored, kind: 'tracker', provider: 'linear' }]);
    // A tracker entry whose tracker id is malformed is dropped.
    expect(getLinkedIssues(sessionWith([{ ...stored, kind: 'tracker', provider: 'Not An Id' }]))).toEqual([]);
  });

  test('survives a non-array payload', () => {
    expect(getLinkedIssues(sessionWith({ nope: true }))).toEqual([]);
  });
});

// The `openchamber` slot is a typed fixture, not external input: these tests
// just built it with withLinkedIssue, so `linked_issues` follows the LinkedIssue
// schema the parser re-checks on read.
const storedIssues = (metadata: SessionMetadataRecord): LinkedIssue[] => {
  // SAFETY: metadata is built by these tests with withLinkedIssue, which always
  // writes openchamber.linked_issues as a LinkedIssue array.
  const openchamber = metadata.openchamber as { linked_issues: LinkedIssue[] };
  return openchamber.linked_issues;
};

describe('withLinkedIssue', () => {
  test('adds a link and preserves unrelated metadata', () => {
    const next = withLinkedIssue(
      { openchamber: { kind: 'review' }, other: 1 },
      issue(),
      true,
    );
    expect(next.other).toBe(1);
    // SAFETY: withLinkedIssue preserves openchamber beside the linked_issues it writes.
    expect((next.openchamber as { kind: 'review' }).kind).toBe('review');
    expect(storedIssues(next)).toEqual([issue()]);
  });

  test('re-linking replaces the entry rather than duplicating it', () => {
    // Linking again is how a drifted title gets refreshed.
    const first = withLinkedIssue({}, issue({ title: 'Old' }), true);
    const second = withLinkedIssue(first, issue({ title: 'New' }), true);
    const stored = storedIssues(second);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('New');
  });

  test('unlinking removes only the matching id', () => {
    const other = issue({ id: 'owner/repo#99', number: 99 });
    const both = withLinkedIssue(withLinkedIssue({}, issue(), true), other, true);
    const next = withLinkedIssue(both, issue(), false);
    expect(storedIssues(next)).toEqual([other]);
  });

  test('unlinking something absent is a no-op, not an error', () => {
    const next = withLinkedIssue({}, issue(), false);
    expect(storedIssues(next)).toEqual([]);
  });

  test('does not carry malformed stored entries forward', () => {
    const next = withLinkedIssue(
      { openchamber: { linked_issues: [{ id: 'broken' }] } },
      issue(),
      true,
    );
    expect(storedIssues(next)).toEqual([issue()]);
  });
});

const matcher = createRepositoryUrlMatcher([githubLikeDescriptor(), gitlabLikeDescriptor(), acmeDescriptor()], []);

describe('getRepositoryThreadRef', () => {
  test('reads a GitHub pull request entry with its instance', () => {
    const entry = issue({ id: 'acme/app#7', number: 7, kind: 'pull', title: 'Fix', url: 'https://github.com/acme/app/pull/7' });
    expect(getRepositoryThreadRef(entry, matcher)).toEqual({
      key: 'github|github.com|acme/app|pull#7', provider: 'github', instance: 'github.com', owner: 'acme', repo: 'app', number: 7, thread: 'pull',
    });
  });

  test('reads the instance, subgroup path and number of a GitLab thread', () => {
    const mergeRequest = issue({ id: 'https://gitlab.example.com/g/sub/app/-/merge_requests/3#3', number: 3, kind: 'pull', url: 'https://gitlab.example.com/g/sub/app/-/merge_requests/3' });
    expect(getRepositoryThreadRef(mergeRequest, matcher)).toMatchObject({
      provider: 'gitlab', instance: 'https://gitlab.example.com', owner: 'g/sub', repo: 'app', number: 3, thread: 'pull',
    });
  });

  test('reads a provider the UI has no code for from its own patterns', () => {
    const link = { id: 'link:https://forge.example.com/org/tool/pulls/4', kind: 'external', thread: 'change', identifier: 'forge', title: 'Acme', url: 'https://forge.example.com/org/tool/pulls/4', linkedAt: 1 } as const;
    expect(getRepositoryThreadRef(link, matcher)).toMatchObject({ provider: 'acme', instance: 'https://forge.example.com', number: 4, thread: 'pull' });
  });

  test('looks nothing up for Linear, an unreadable address, or an entry whose number disagrees', () => {
    expect(getRepositoryThreadRef(buildLinkedTrackerItem({ provider: 'linear', identifier: 'ENG-1', title: 'x', url: 'https://linear.app/x', linkedAt: 1 }), matcher)).toBeNull();
    expect(getRepositoryThreadRef(issue({ id: 'x', number: 1, url: 'https://example.com/not/a/thread' }), matcher)).toBeNull();
    expect(getRepositoryThreadRef(issue({ number: 13 }), matcher)).toBeNull();
  });
});

describe('getLinkedSidebarChanges', () => {
  test('lists every linked change once, repository ones with their thread and provider reference', () => {
    const session = sessionWith([
      issue({ id: 'acme/app#7', number: 7, kind: 'pull', title: 'Fix', url: 'https://github.com/acme/app/pull/7' }),
      { id: 'guest:gitea:5', providerId: 'gitea', identifier: '5', title: 'Guest PR', url: 'https://gitea/x', kind: 'guest', thread: 'pull', linkedAt: 1 },
      { id: 'link:https://gitlab.com/a/b/-/merge_requests/42', kind: 'external', thread: 'change', identifier: '!42', title: 'MR', url: 'https://gitlab.com/a/b/-/merge_requests/42', linkedAt: 1 },
      { id: 'link:https://jira.example/OPS-7', kind: 'external', thread: 'issue', identifier: 'OPS-7', title: 'Outage', url: 'https://jira.example/OPS-7', linkedAt: 1 },
      { id: 'linear:ENG-1', identifier: 'ENG-1', title: 'Linear', url: 'https://linear.app/x', kind: 'linear', linkedAt: 1 },
    ]);
    expect(getLinkedSidebarChanges(session, matcher)).toEqual([
      {
        key: 'github|github.com|acme/app|pull#7', identifier: '#7', url: 'https://github.com/acme/app/pull/7', title: 'Fix',
        repository: { key: 'github|github.com|acme/app|pull#7', provider: 'github', instance: 'github.com', owner: 'acme', repo: 'app', number: 7, thread: 'pull' },
      },
      { key: 'guest:gitea:5', identifier: '5', url: 'https://gitea/x', title: 'Guest PR' },
      {
        key: 'gitlab|https://gitlab.com|a/b|pull#42', identifier: '!42', url: 'https://gitlab.com/a/b/-/merge_requests/42', title: 'MR',
        repository: { key: 'gitlab|https://gitlab.com|a/b|pull#42', provider: 'gitlab', instance: 'https://gitlab.com', owner: 'a', repo: 'b', number: 42, thread: 'pull' },
      },
    ]);
  });
});

describe('getLinkedSidebarIssues', () => {
  test('lists repository issues with their thread and trackers by identifier, never pull requests', () => {
    const session = sessionWith([
      issue(),
      issue({ id: 'acme/app#7', number: 7, kind: 'pull', url: 'https://github.com/acme/app/pull/7' }),
      { id: 'linear:ENG-1', identifier: 'ENG-1', title: 'Linear task', url: 'https://linear.app/x', kind: 'linear', linkedAt: 1 },
      { id: 'guest:jira:OPS-2', providerId: 'jira', identifier: 'OPS-2', title: 'Ops', url: 'https://jira/x', kind: 'guest', thread: 'issue', linkedAt: 1 },
      { id: 'guest:gitea:5', providerId: 'gitea', identifier: '5', title: 'Guest PR', url: 'https://gitea/x', kind: 'guest', thread: 'pull', linkedAt: 1 },
    ]);
    expect(getLinkedSidebarIssues(session, matcher)).toEqual([
      {
        source: 'repository', key: 'github|github.com|owner/repo|issue#12', identifier: '#12', url: 'https://github.com/owner/repo/issues/12', title: 'Rail badge count',
        ref: { key: 'github|github.com|owner/repo|issue#12', provider: 'github', instance: 'github.com', owner: 'owner', repo: 'repo', number: 12, thread: 'issue' },
      },
      { source: 'tracker', provider: 'linear', key: 'linear:ENG-1', identifier: 'ENG-1', url: 'https://linear.app/x', title: 'Linear task' },
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
    expect(getLinkedSidebarIssues(session, matcher)).toEqual([
      { source: 'external', key: 'link:https://jira.example/OPS-7', identifier: 'OPS-7', url: 'https://jira.example/OPS-7', title: 'Outage' },
    ]);
  });

  test('gives a GitLab issue its thread once, however it was linked', () => {
    const url = 'https://gitlab.com/team/app/-/issues/8';
    const session = sessionWith([
      issue({ id: 'gitlab.com:team/app#8', number: 8, kind: 'issue', url }),
      { id: `link:${url}`, kind: 'external', thread: 'issue', identifier: '#8', title: 'Same issue', url, linkedAt: 2 },
      issue({ id: 'mr', number: 3, kind: 'pull', url: 'https://gitlab.com/team/app/-/merge_requests/3' }),
    ]);
    expect(getLinkedSidebarIssues(session, matcher)).toMatchObject([
      { source: 'repository', identifier: '#8', ref: { provider: 'gitlab', number: 8, thread: 'issue' } },
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
    expect(getLinkedSidebarChanges(session, matcher).map((change) => change.repository?.number)).toEqual([7, 8]);
    expect(getDistinctLinkedIssues(session, matcher).map((entry) => entry.id)).toEqual([
      'acme/app#7', 'guest:gh:8', 'link:https://github.com/acme/app/issues/9',
    ]);
    expect(getLinkedSidebarIssues(session, matcher)).toMatchObject([
      { source: 'repository', identifier: '#9', url: 'https://github.com/acme/app/issues/9', title: 'Bug', ref: { owner: 'acme', repo: 'app', number: 9 } },
    ]);
  });
});

describe('links to a GitHub-shaped address on an enterprise host', () => {
  test('a github.com link keeps the tracked key it always had, an enterprise-host link carries its host', () => {
    const session = sessionWith([
      { id: 'link:https://www.github.com/acme/app/pull/7', kind: 'external', thread: 'change', identifier: 'github.com', title: 'Public', url: 'https://www.github.com/acme/app/pull/7', linkedAt: 1 },
      { id: 'link:https://ghe.example.com/acme/app/pull/7', kind: 'external', thread: 'change', identifier: 'ghe.example.com', title: 'Internal', url: 'https://ghe.example.com/acme/app/pull/7', linkedAt: 2 },
    ]);
    // The tracked items the two hosts produce are host-scoped: the same
    // owner/repo/number on github.com and an enterprise host stay apart.
    expect(getLinkedSidebarChanges(session, matcher).flatMap((change) => (
      change.repository ? [trackedItemKey(repositoryThread('pull', change.repository))] : []
    ))).toEqual([
      'github|github.com|pull|acme/app#7',
      'github|ghe.example.com|pull|acme/app#7',
    ]);
  });

  test('an enterprise-host link and its stored entry are the same thread', () => {
    const stored = issue({ id: 'ghe.example.com:acme/app#7', number: 7, kind: 'pull', url: 'https://ghe.example.com/acme/app/pull/7' });
    const link = { id: 'link:https://ghe.example.com/acme/app/pull/7', kind: 'external', thread: 'change', identifier: 'ghe.example.com', title: 'Same PR', url: 'https://ghe.example.com/acme/app/pull/7', linkedAt: 2 };
    expect(getLinkedSidebarChanges(sessionWith([stored, link]), matcher)).toMatchObject([
      { url: 'https://ghe.example.com/acme/app/pull/7', title: 'Rail badge count', repository: { instance: 'ghe.example.com', owner: 'acme', repo: 'app', number: 7 } },
    ]);
  });
});

describe('links to a GitLab thread', () => {
  test('are listed once, at the first link, whatever address each was written with', () => {
    const session = sessionWith([
      { id: 'link:https://gitlab.com/a/b/-/merge_requests/600', kind: 'external', thread: 'change', identifier: '!600', title: 'MR', url: 'https://gitlab.com/a/b/-/merge_requests/600', linkedAt: 1 },
      { id: 'link:https://gitlab.com/a/b/-/merge_requests/600/diffs', kind: 'external', thread: 'change', identifier: '!600', title: 'MR review', url: 'https://gitlab.com/a/b/-/merge_requests/600/diffs', linkedAt: 2 },
      { id: 'link:https://gitlab.com/a/b/-/merge_requests/601', kind: 'external', thread: 'change', identifier: '!601', title: 'Other', url: 'https://gitlab.com/a/b/-/merge_requests/601', linkedAt: 3 },
    ]);
    expect(getDistinctLinkedIssues(session, matcher).map((entry) => entry.title)).toEqual(['MR', 'Other']);
  });
});
