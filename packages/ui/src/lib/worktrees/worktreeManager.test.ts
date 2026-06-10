import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
};

const listCalls: string[] = [];
const listResolvers: Array<(value: WorktreeListEntry[]) => void> = [];
const createdWorktree = {
  name: 'feature',
  branch: 'feature',
  path: '/repo-feature',
  directoryCreated: true as const,
  bootstrapStatus: { status: 'pending' as const, error: null, updatedAt: 1 },
};

const sessionState = {
  availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(),
  availableWorktrees: [] as WorktreeMetadata[],
};

mock.module('@/lib/openchamberConfig', () => ({
  substituteCommandVariables: (command: string) => command,
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  clearWorktreeBootstrapState: mock(),
  markWorktreeBootstrapPending: mock(),
  setWorktreeBootstrapState: mock(),
  startWorktreeBootstrapWatcher: mock(),
}));

mock.module('@/lib/worktrees/worktreeStatus', () => ({
  invalidateResolvedProjectRootCache: mock(),
  resolveProjectRoot: (directory: string) => Promise.resolve(directory),
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => sessionState,
    setState: (patch: Partial<typeof sessionState> | ((state: typeof sessionState) => Partial<typeof sessionState>)) => {
      const next = typeof patch === 'function' ? patch(sessionState) : patch;
      Object.assign(sessionState, next);
    },
  },
}));

mock.module('@/lib/gitApi', () => ({
  deleteRemoteBranch: mock(),
  git: {
    worktree: {
      list: (directory: string) => {
        listCalls.push(directory);
        return new Promise<WorktreeListEntry[]>((resolve) => {
          listResolvers.push(resolve);
        });
      },
      create: mock(() => Promise.resolve(createdWorktree)),
      remove: mock(() => Promise.resolve({ success: true })),
    },
  },
}));

const { createWorktree, listProjectWorktrees } = await import('./worktreeManager');

const waitForListCallCount = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (listCalls.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} worktree list calls, got ${listCalls.length}`);
};

describe('worktreeManager list invalidation', () => {
  beforeEach(() => {
    listCalls.length = 0;
    listResolvers.length = 0;
    sessionState.availableWorktreesByProject = new Map();
    sessionState.availableWorktrees = [];
  });

  test('retries an in-flight list when a worktree is created before it resolves', async () => {
    const project = { id: 'project-1', path: '/repo' };
    const listing = listProjectWorktrees(project);

    await waitForListCallCount(1);

    await createWorktree(project, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
    });

    listResolvers[0]([]);
    await waitForListCallCount(2);
    listResolvers[1]([createdWorktree]);

    const result = await listing;

    expect(listCalls).toEqual(['/repo', '/repo']);
    expect(result.map((entry) => entry.path)).toEqual(['/repo-feature']);
  });

  test('marks fast-created worktrees pending until bootstrap settles', async () => {
    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    });

    expect(metadata.worktreeStatus).toBe('pending');
    expect(sessionState.availableWorktrees[0]?.worktreeStatus).toBe('pending');
  });
});
