import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildLinkedIssue, buildLinkedIssueId, buildLinkedLinearIssue, canOpenLinearIssueInContextPanel, getLinkedIssues, withLinkedIssue, type LinkedIssue } from './linkedIssues';

type LinkedGitHubIssue = Exclude<LinkedIssue, { kind: 'linear' }>;

const issue = (overrides: Partial<LinkedGitHubIssue> = {}): LinkedGitHubIssue => ({
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
