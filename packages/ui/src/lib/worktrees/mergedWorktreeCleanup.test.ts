import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import {
  decideMergedWorktreeCleanup,
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
  isDirty?: boolean | null;
  hasUnmergedCommits?: boolean | null;
  gitFails?: boolean;
  handled?: boolean;
  archiveFails?: boolean;
}) => {
  const handled = new Set<string>(options.handled ? [WORKTREE] : []);
  const archived: string[][] = [];
  const reports: MergedWorktreeOutcome[] = [];
  const calls = { archived, removed: 0, reports };
  const deps = {
    listCandidates: () => [candidate],
    isHandled: (entry: MergedWorktreeCandidate) => handled.has(entry.worktree.path),
    markHandled: (entry: MergedWorktreeCandidate) => { handled.add(entry.worktree.path); },
    getActiveSessions: () => options.sessions ?? [session('a'), session('elsewhere', '/projects/app')],
    isSessionIdle: (id: string) => !(options.busy ?? []).includes(id),
    isSessionOpen: (id: string) => (options.open ?? []).includes(id),
    isWorktreeOpen: () => options.worktreeOpen ?? false,
    readWorktreeState: async () => {
      if (options.gitFails) throw new Error('git unavailable');
      return { isDirty: options.isDirty ?? false, hasUnmergedCommits: options.hasUnmergedCommits === undefined ? false : options.hasUnmergedCommits };
    },
    archiveSessions: async (ids: string[]) => {
      calls.archived.push(ids);
      return { failedIds: options.archiveFails ? ids : [] };
    },
    removeWorktree: async () => { calls.removed += 1; },
    report: (outcome: MergedWorktreeOutcome) => { calls.reports.push(outcome); },
  };
  return { deps, calls, handled };
};

describe('decideMergedWorktreeCleanup', () => {
  const base = { sessionsBusyOrUnknown: false, sessionOpen: false, isDirty: false, hasUnmergedCommits: false };

  test('removes only when the checkout is clean and holds no commit the merged PR lacks', () => {
    expect(decideMergedWorktreeCleanup(base)).toEqual({ action: 'remove' });
    expect(decideMergedWorktreeCleanup({ ...base, isDirty: true })).toEqual({ action: 'archive-only' });
    expect(decideMergedWorktreeCleanup({ ...base, isDirty: null })).toEqual({ action: 'archive-only' });
    expect(decideMergedWorktreeCleanup({ ...base, hasUnmergedCommits: true })).toEqual({ action: 'archive-only' });
    expect(decideMergedWorktreeCleanup({ ...base, hasUnmergedCommits: null })).toEqual({ action: 'archive-only' });
  });

  test('waits while an agent runs or a session is open', () => {
    expect(decideMergedWorktreeCleanup({ ...base, sessionsBusyOrUnknown: true })).toEqual({ action: 'wait' });
    expect(decideMergedWorktreeCleanup({ ...base, sessionOpen: true })).toEqual({ action: 'wait' });
  });
});

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
  test('archives the worktree sessions, then removes the worktree', async () => {
    const { deps, calls } = setup({});
    await runMergedWorktreeCleanup(deps);
    expect(calls.archived).toEqual([['a']]);
    expect(calls.removed).toBe(1);
    expect(calls.reports.map((entry) => entry.kind)).toEqual(['removed']);
  });

  test('keeps a worktree with commits after the merge, archives its sessions once', async () => {
    const { deps, calls } = setup({ hasUnmergedCommits: true });
    await runMergedWorktreeCleanup(deps);
    await runMergedWorktreeCleanup(deps);
    expect(calls.archived).toEqual([['a']]);
    expect(calls.removed).toBe(0);
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

  test('git that cannot answer decides nothing', async () => {
    const { deps, calls, handled } = setup({ gitFails: true });
    await runMergedWorktreeCleanup(deps);
    expect(calls.archived).toEqual([]);
    expect(handled.size).toBe(0);
  });

  test('a failed archive keeps the worktree and is reported', async () => {
    const { deps, calls } = setup({ archiveFails: true });
    await runMergedWorktreeCleanup(deps);
    expect(calls.removed).toBe(0);
    expect(calls.reports.map((entry) => entry.kind)).toEqual(['failed']);
  });

  test('a kept worktree without sessions stays quiet', async () => {
    const { deps, calls } = setup({ sessions: [], isDirty: true });
    await runMergedWorktreeCleanup(deps);
    expect(calls.reports).toEqual([]);
  });

  test('a kept worktree nobody works in goes once nothing there can be lost', async () => {
    const state = { isDirty: true };
    const { deps, calls } = setup({ sessions: [] });
    deps.readWorktreeState = async () => ({ isDirty: state.isDirty, hasUnmergedCommits: false });
    await runMergedWorktreeCleanup(deps);
    expect(calls.removed).toBe(0);
    state.isDirty = false;
    // Only the periodic pass rechecks a kept worktree.
    await runMergedWorktreeCleanup(deps, { recheckKept: false });
    expect(calls.removed).toBe(0);
    await runMergedWorktreeCleanup(deps);
    expect(calls.removed).toBe(1);
    expect(calls.archived).toEqual([]);
    expect(calls.reports.map((entry) => entry.kind)).toEqual(['removed']);
  });

  test('sessions in a kept worktree mean the work went on there: nothing is archived or removed', async () => {
    const { deps, calls } = setup({ handled: true });
    await runMergedWorktreeCleanup(deps);
    expect(calls.archived).toEqual([]);
    expect(calls.removed).toBe(0);
  });
});
