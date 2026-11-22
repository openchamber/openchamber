import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';

const archivedSessionIds: string[][] = [];
const restoredSessionIds: string[][] = [];
const worktreeArchives: Array<{ sessionIds: string[] }> = [];
const teardowns: Array<{ projectDirectory: string; directory: string; teardownCommand: string }> = [];
let runTeardown: () => Promise<void> = async () => undefined;
const teardownAsks: Array<boolean | undefined> = [];
let resolveTeardown: () => Promise<string | undefined> = async () => undefined;

type ProjectRef = { id: string; path: string };

mock.module('@/lib/worktrees/worktreeManager', () => ({
  resolveWorktreeTeardownCommand: (_project: ProjectRef, _worktree: WorktreeMetadata, options?: { ask?: boolean }) => {
    teardownAsks.push(options?.ask);
    return resolveTeardown();
  },
  archiveProjectWorktree: async (_project: ProjectRef, _worktree: WorktreeMetadata, input: { sessionIds: string[] }) => {
    worktreeArchives.push({ sessionIds: input.sessionIds });
    return { id: 'a1' };
  },
  createWorktree: mock(),
  listProjectWorktrees: mock(),
  removeProjectWorktree: mock(),
}));

const actualSessionActions = await import('@/sync/session-actions');
mock.module('@/sync/session-actions', () => ({
  ...actualSessionActions,
  archiveSessions: async (ids: string[]) => {
    archivedSessionIds.push(ids);
    return { archivedIds: ids, failedIds: [] };
  },
  unarchiveSessions: async (ids: string[]) => {
    restoredSessionIds.push(ids);
    return { failedIds: [] };
  },
}));

mock.module('@/lib/gitApi', () => ({
  canArchiveWorktrees: () => false,
  git: {
    worktree: {
      teardown: async (projectDirectory: string, payload: { directory: string; teardownCommand: string }) => {
        teardowns.push({ projectDirectory, ...payload });
        await runTeardown();
        return true;
      },
    },
  },
}));
mock.module('@/lib/sharedTrustConfirmation', () => ({ resolveWorktreeSetupCommandsOrCancel: mock() }));

// The module subscribes to runtime switches at import, which needs a window.
const dom = new Window({ url: 'http://instance-a.test' });
for (const [name, value] of Object.entries({ window: dom, CustomEvent: dom.CustomEvent })) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { archiveWorktreeWork } = await import('./worktreeArchive');

const project = { id: 'project', path: '/repo' };
const worktree: WorktreeMetadata = { path: '/repo-feature', branch: 'feature', projectDirectory: '/repo', label: 'feature' };
const session: Session = {
  id: 'ses_1',
  projectID: 'project',
  directory: '/repo-feature',
  title: 'Feature',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
};

describe('archiveWorktreeWork teardown', () => {
  beforeEach(() => {
    archivedSessionIds.length = 0;
    restoredSessionIds.length = 0;
    worktreeArchives.length = 0;
    teardownAsks.length = 0;
    teardowns.length = 0;
    runTeardown = async () => undefined;
  });

  test('a pass nobody started leaves the sessions alone when the shared teardown is not trusted', async () => {
    resolveTeardown = () => Promise.reject(new Error('The repository\'s teardown commands are not trusted yet'));

    await expect(archiveWorktreeWork({ project, worktree, sessions: [session], askForTrust: false })).rejects.toThrow('not trusted yet');

    expect(teardownAsks).toEqual([false]);
    expect(archivedSessionIds).toEqual([]);
    expect(restoredSessionIds).toEqual([]);
    expect(worktreeArchives).toEqual([]);
  });

  test('a failing teardown archives and restores nothing', async () => {
    resolveTeardown = async () => 'docker compose down';
    runTeardown = () => Promise.reject(new Error('stack still running'));

    await expect(archiveWorktreeWork({ project, worktree, sessions: [session], askForTrust: false })).rejects.toThrow('stack still running');

    expect(archivedSessionIds).toEqual([]);
    expect(restoredSessionIds).toEqual([]);
    expect(worktreeArchives).toEqual([]);
  });

  test('Done runs the teardown before any session is archived, then archives the worktree', async () => {
    const order: string[] = [];
    resolveTeardown = async () => 'docker compose down';
    runTeardown = async () => {
      order.push(`teardown, ${archivedSessionIds.length} sessions archived`);
    };

    await archiveWorktreeWork({ project, worktree, sessions: [session] });

    expect(order).toEqual(['teardown, 0 sessions archived']);
    expect(teardownAsks).toEqual([undefined]);
    expect(teardowns).toEqual([{ projectDirectory: '/repo', directory: '/repo-feature', teardownCommand: 'docker compose down' }]);
    expect(archivedSessionIds).toEqual([['ses_1']]);
    expect(worktreeArchives).toEqual([{ sessionIds: ['ses_1'] }]);
  });

  test('nothing to tear down archives without a teardown request', async () => {
    resolveTeardown = async () => undefined;

    await archiveWorktreeWork({ project, worktree, sessions: [session] });

    expect(teardowns).toEqual([]);
    expect(worktreeArchives).toEqual([{ sessionIds: ['ses_1'] }]);
  });
});
