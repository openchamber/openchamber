import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GitWorktreeCreateResult } from '@/lib/api/types';
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
  head: 'abc123',
  name: 'feature',
  branch: 'feature',
  path: '/repo-feature',
  directoryCreated: true as const,
  bootstrapStatus: { status: 'pending' as const, error: null, updatedAt: 1 },
};
let createdWorktreeResult: GitWorktreeCreateResult = createdWorktree;
const bootstrapWatcherCalls: string[] = [];
const bootstrapWatcherOptions: Array<{ onReady?: () => void }> = [];

const sessionState = {
  availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(),
  availableWorktrees: [] as WorktreeMetadata[],
  worktreeMetadata: new Map<string, WorktreeMetadata>(),
};
const attachmentState = {
  attachments: new Map<string, { worktreeStatus: 'pending' | 'ready'; worktreeRoot: string }>(),
};

mock.module('@/lib/openchamberConfig', () => ({
  substituteCommandVariables: (command: string) => command,
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  clearWorktreeBootstrapState: mock(),
  markWorktreeBootstrapPending: mock(),
  setWorktreeBootstrapState: mock(),
  startWorktreeBootstrapWatcher: (directory: string, options?: { onReady?: () => void }) => {
    bootstrapWatcherCalls.push(directory);
    bootstrapWatcherOptions.push(options ?? {});
  },
}));

mock.module('@/sync/session-worktree-store', () => ({
  useSessionWorktreeStore: {
    setState: (patch: Partial<typeof attachmentState> | ((state: typeof attachmentState) => Partial<typeof attachmentState>)) => {
      const next = typeof patch === 'function' ? patch(attachmentState) : patch;
      Object.assign(attachmentState, next);
    },
  },
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
      create: mock(() => Promise.resolve(createdWorktreeResult)),
      remove: mock(() => Promise.resolve({ success: true })),
    },
  },
}));

const { createWorktree, getLatestWorktreeMetadata, listProjectWorktrees, worktreeMapsEqual } = await import('./worktreeManager');

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
    bootstrapWatcherCalls.length = 0;
    bootstrapWatcherOptions.length = 0;
    createdWorktreeResult = createdWorktree;
    sessionState.availableWorktreesByProject = new Map();
    sessionState.availableWorktrees = [];
    sessionState.worktreeMetadata = new Map();
    attachmentState.attachments = new Map();
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
    expect(bootstrapWatcherCalls).toEqual(['/repo-feature']);
  });

  test('treats legacy create responses without bootstrap state as fully ready', async () => {
    createdWorktreeResult = {
      head: '',
      name: 'legacy-feature',
      branch: 'legacy-feature',
      path: '/repo-legacy-feature',
    };

    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'legacy-feature',
      mode: 'new',
      branchName: 'legacy-feature',
      worktreeName: 'legacy-feature',
      returnAfterDirectoryCreated: true,
    });

    expect(metadata.worktreeStatus).toBe('ready');
    expect(bootstrapWatcherCalls).toEqual([]);
  });

  test('reconciles session attachments when bootstrap becomes ready', async () => {
    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    });
    sessionState.worktreeMetadata.set('session-1', metadata);
    attachmentState.attachments.set('session-1', {
      worktreeRoot: metadata.path,
      worktreeStatus: 'pending',
    });

    bootstrapWatcherOptions[0]?.onReady?.();

    expect(sessionState.worktreeMetadata.get('session-1')?.worktreeStatus).toBe('ready');
    expect(attachmentState.attachments.get('session-1')?.worktreeStatus).toBe('ready');
  });

  test('resolves ready metadata when bootstrap settles before the session is attached', async () => {
    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    });

    bootstrapWatcherOptions[0]?.onReady?.();

    expect(metadata.worktreeStatus).toBe('pending');
    expect(getLatestWorktreeMetadata(metadata).worktreeStatus).toBe('ready');
  });
});

describe('worktreeMapsEqual', () => {
  const wt = (
    path: string,
    branch: string,
    overrides: Partial<WorktreeMetadata> = {},
  ): WorktreeMetadata => ({
    path,
    branch,
    projectDirectory: '/repo',
    label: branch,
    ...overrides,
  });

  test('returns true for two empty maps', () => {
    const a = new Map<string, WorktreeMetadata[]>();
    const b = new Map<string, WorktreeMetadata[]>();
    expect(worktreeMapsEqual(a, b)).toBe(true);
  });

  test('returns true when paths and branches match in order', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(true);
  });

  test('returns false when same path has a different branch (external git checkout)', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'develop')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when head state changes without a branch change', () => {
    const a = new Map([['/repo', [wt('/r/main', '', { headState: 'unborn' })]]]);
    const b = new Map([['/repo', [wt('/r/main', '', { headState: 'detached' })]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when discovered display metadata changes', () => {
    const a = new Map([['/repo', [wt('/r/main', '', { name: 'old', label: 'old' })]]]);
    const b = new Map([['/repo', [wt('/r/main', '', { name: 'new', label: 'new' })]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when paths differ', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/other', 'main')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when per-project array lengths differ', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when number of project keys differ', () => {
    const a = new Map<string, WorktreeMetadata[]>([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map<string, WorktreeMetadata[]>([
      ['/repo', [wt('/r/main', 'main')]],
      ['/repo-2', [wt('/r2/main', 'main')]],
    ]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when worktrees are reordered (positional compare)', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    const b = new Map([['/repo', [wt('/r/feat', 'feat'), wt('/r/main', 'main')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when a non-first worktree differs (subset of entries)', () => {
    const a = new Map([
      ['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat'), wt('/r/old', 'old')]],
    ]);
    const b = new Map([
      ['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat'), wt('/r/old', 'new-branch')]],
    ]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });
});
