import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';

const archivedSessionIds: string[][] = [];
const restoredSessionIds: string[][] = [];
const worktreeArchives: Array<{ sessionIds: string[]; teardownCommand?: string }> = [];
const teardownAsks: Array<boolean | undefined> = [];
let resolveTeardown: () => Promise<string | undefined> = async () => undefined;

type ProjectRef = { id: string; path: string };

mock.module('@/lib/worktrees/worktreeManager', () => ({
  resolveWorktreeTeardownCommand: (_project: ProjectRef, _worktree: WorktreeMetadata, options?: { ask?: boolean }) => {
    teardownAsks.push(options?.ask);
    return resolveTeardown();
  },
  archiveProjectWorktree: async (_project: ProjectRef, _worktree: WorktreeMetadata, input: { sessionIds: string[]; teardownCommand?: string }) => {
    worktreeArchives.push({ sessionIds: input.sessionIds, teardownCommand: input.teardownCommand });
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

mock.module('@/lib/gitApi', () => ({ canArchiveWorktrees: () => false, git: { worktree: {} } }));
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
  });

  test('a pass nobody started leaves the sessions alone when the shared teardown is not trusted', async () => {
    resolveTeardown = () => Promise.reject(new Error('The repository\'s teardown commands are not trusted yet'));

    await expect(archiveWorktreeWork({ project, worktree, sessions: [session], askForTrust: false })).rejects.toThrow('not trusted yet');

    expect(teardownAsks).toEqual([false]);
    expect(archivedSessionIds).toEqual([]);
    expect(restoredSessionIds).toEqual([]);
    expect(worktreeArchives).toEqual([]);
  });

  test('Done resolves the teardown before any session is archived and sends it with the archive', async () => {
    const order: string[] = [];
    resolveTeardown = async () => {
      order.push(`teardown, ${archivedSessionIds.length} sessions archived`);
      return 'docker compose down';
    };

    await archiveWorktreeWork({ project, worktree, sessions: [session] });

    expect(order).toEqual(['teardown, 0 sessions archived']);
    expect(teardownAsks).toEqual([undefined]);
    expect(archivedSessionIds).toEqual([['ses_1']]);
    expect(worktreeArchives).toEqual([{ sessionIds: ['ses_1'], teardownCommand: 'docker compose down' }]);
  });
});
