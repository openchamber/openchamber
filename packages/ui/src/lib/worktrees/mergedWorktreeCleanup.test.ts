import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import {
  hasUnmergedCommits,
  runMergedWorktreeCleanup,
  type MergedWorktreeCandidate,
  type MergedWorktreeOutcome,
} from './mergedWorktreeCleanup';

const WORKTREE = '/worktrees/feature';
const SHA = 'abc123';

const session = (id: string, directory = WORKTREE): Session => ({
  id,
  projectID: 'app',
  title: id,
  directory,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

const candidate: MergedWorktreeCandidate = {
  worktree: { path: WORKTREE, projectDirectory: '/projects/app', branch: 'feature', label: 'feature', worktreeStatus: 'ready' },
  project: { id: 'app', path: '/projects/app' },
  prNumber: 7,
  mergedHeadSha: SHA,
};

const setup = (options: {
  sessions?: Session[];
  busy?: string[];
  open?: string[];
  worktreeOpen?: boolean;
  handled?: boolean;
  archiveFails?: boolean;
  removing?: boolean;
  restored?: boolean;
}) => {
  let restored = options.restored ?? false;
  const handled = new Set<string>(options.handled ? [WORKTREE] : []);
  const archived: string[][] = [];
  const reports: MergedWorktreeOutcome[] = [];
  const calls = { archived, reports };
  const deps = {
    listCandidates: () => [candidate],
    isHandled: (entry: MergedWorktreeCandidate) => handled.has(entry.worktree.path),
    markHandled: (entry: MergedWorktreeCandidate) => { handled.add(entry.worktree.path); },
    getActiveSessions: () => options.sessions ?? [session('a'), session('elsewhere', '/projects/app')],
    isSessionIdle: (id: string) => !(options.busy ?? []).includes(id),
    isSessionOpen: (id: string) => (options.open ?? []).includes(id),
    isWorktreeOpen: () => options.worktreeOpen ?? false,
    isWorktreeRemoving: () => options.removing ?? false,
    takeRestored: () => {
      const answer = restored;
      restored = false;
      return answer;
    },
    archiveWorktree: async (_entry: MergedWorktreeCandidate, sessions: readonly Session[]) => {
      if (options.archiveFails) throw new Error('archive failed');
      calls.archived.push(sessions.map((entry) => entry.id));
    },
    report: (outcome: MergedWorktreeOutcome) => { calls.reports.push(outcome); },
  };
  return { deps, calls, handled };
};

describe('hasUnmergedCommits', () => {
  const pushed = { tracking: 'origin/feature', ahead: 0 };

  test('the PR head answers when this clone has it, including a checkout behind it', async () => {
    expect(await hasUnmergedCommits({ mergedHeadSha: SHA, status: pushed, hasCommitsAfter: async () => false })).toBe(false);
    expect(await hasUnmergedCommits({ mergedHeadSha: SHA, status: pushed, hasCommitsAfter: async () => true })).toBe(true);
  });

  test('without the PR head, only a branch with nothing left to push has lost nothing', async () => {
    const missing = async (): Promise<boolean> => { throw new Error('unknown revision'); };
    expect(await hasUnmergedCommits({ mergedHeadSha: SHA, status: pushed, hasCommitsAfter: missing })).toBe(false);
    expect(await hasUnmergedCommits({ mergedHeadSha: SHA, status: { ...pushed, ahead: 2 }, hasCommitsAfter: missing })).toBe(true);
    expect(await hasUnmergedCommits({ mergedHeadSha: SHA, status: { tracking: null, ahead: 0 }, hasCommitsAfter: missing })).toBeNull();
    expect(await hasUnmergedCommits({ mergedHeadSha: null, status: { tracking: null, ahead: 0 }, hasCommitsAfter: missing })).toBeNull();
  });
});

describe('runMergedWorktreeCleanup', () => {
  test('archives the worktree with its own sessions, once', async () => {
    const { deps, calls } = setup({});
    await runMergedWorktreeCleanup(deps);
    await runMergedWorktreeCleanup(deps);
    expect(calls.archived).toEqual([['a']]);
    expect(calls.reports.map((entry) => entry.kind)).toEqual(['archived']);
  });

  test('a busy agent, an open session or an open draft there leaves it for a later pass', async () => {
    for (const options of [{ busy: ['a'] }, { open: ['a'] }, { worktreeOpen: true }]) {
      const { deps, calls, handled } = setup(options);
      await runMergedWorktreeCleanup(deps);
      expect(calls.archived).toEqual([]);
      expect(handled.size).toBe(0);
    }
  });

  test('a worktree without sessions is archived too', async () => {
    const { deps, calls } = setup({ sessions: [] });
    await runMergedWorktreeCleanup(deps);
    expect(calls.archived).toEqual([[]]);
  });

  test('leaves alone a worktree something else is archiving or removing', async () => {
    const { deps, calls, handled } = setup({ removing: true });
    await runMergedWorktreeCleanup(deps);
    expect(calls.archived).toEqual([]);
    expect(handled.size).toBe(0);
  });

  test('a worktree restored after its PR merged is the user taking it back: never archived for that PR', async () => {
    const { deps, calls, handled } = setup({ restored: true });
    await runMergedWorktreeCleanup(deps);
    await runMergedWorktreeCleanup(deps);
    expect(calls.archived).toEqual([]);
    expect(handled.size).toBe(1);
  });

  test('a failed archive is reported and not tried again on every pass', async () => {
    const { deps, calls } = setup({ archiveFails: true });
    await runMergedWorktreeCleanup(deps);
    await runMergedWorktreeCleanup(deps);
    expect(calls.reports.map((entry) => entry.kind)).toEqual(['failed']);
  });
});
