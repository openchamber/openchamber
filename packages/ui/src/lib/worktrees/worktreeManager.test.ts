import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GitNetworkOperation, GitNetworkOperationPlan, GitWorktreeCreateResult, RemoveGitWorktreePayload, SourceControlBindingRead } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
};

const listCalls: string[] = [];
const listResolvers: Array<(value: WorktreeListEntry[]) => void> = [];
const listRejecters: Array<(reason: Error) => void> = [];
let listImplementation: ((directory: string) => Promise<WorktreeListEntry[]>) | undefined;
const createPayloads: unknown[] = [];
const validatePayloads: unknown[] = [];
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
const warningToasts: string[] = [];
const removeCalls: Array<{ directory: string; payload: RemoveGitWorktreePayload }> = [];

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

mock.module('@/components/ui', () => ({
  toast: {
    warning: (message: string) => warningToasts.push(message),
  },
}));

mock.module('@/lib/i18n', () => ({
  formatMessage: () => 'session.newWorktree.toast.fetchSourceFailed',
  useI18nStore: { getState: () => ({ dictionary: {} }) },
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
        if (listImplementation) {
          return listImplementation(directory);
        }
        return new Promise<WorktreeListEntry[]>((resolve, reject) => {
          listResolvers.push(resolve);
          listRejecters.push((reason: Error) => reject(reason));
        });
      },
      create: mock((_directory: string, payload: unknown) => {
        createPayloads.push(payload);
        return Promise.resolve(createdWorktreeResult);
      }),
      validate: mock((_directory: string, payload: unknown) => {
        validatePayloads.push(payload);
        return Promise.resolve({ ok: true, errors: [] });
      }),
      remove: mock((directory: string, payload: RemoveGitWorktreePayload) => {
        removeCalls.push({ directory, payload });
        return Promise.resolve({ success: true });
      }),
    },
  },
}));

const {
  createWorktree,
  getLatestWorktreeMetadata,
  listProjectWorktrees,
  partitionWorktreesByRegisteredProject,
  preserveClientTrackedWorktreeStatus,
  replaceRepositoryWorktrees,
  removeProjectWorktree,
  validateWorktreeCreate,
  worktreeMapsEqual,
} = await import('./worktreeManager');

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
    listRejecters.length = 0;
    listImplementation = undefined;
    createPayloads.length = 0;
    validatePayloads.length = 0;
    bootstrapWatcherCalls.length = 0;
    bootstrapWatcherOptions.length = 0;
    warningToasts.length = 0;
    removeCalls.length = 0;
    createdWorktreeResult = createdWorktree;
    sessionState.availableWorktreesByProject = new Map();
    sessionState.availableWorktrees = [];
    sessionState.worktreeMetadata = new Map();
    attachmentState.attachments = new Map();
  });

  test('warns when worktree creation falls back after a source fetch failure', async () => {
    createdWorktreeResult = { ...createdWorktree, sourceFetchFailed: true };

    await createWorktree({ id: 'project-fetch-fallback', path: '/repo' }, {
      branchName: 'feature',
      worktreeName: 'feature',
    });

    expect(warningToasts).toEqual(['session.newWorktree.toast.fetchSourceFailed']);
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

  test('forced refresh bypasses a fresh cached result', async () => {
    const project = { id: 'project-force-cache', path: '/repo-force-cache' };

    const initialListing = listProjectWorktrees(project);
    await waitForListCallCount(1);
    listResolvers[0]([]);
    const initialResult = await initialListing;
    expect(initialResult).toEqual([]);

    const cachedResult = await listProjectWorktrees(project);
    expect(cachedResult).toEqual([]);
    expect(listCalls).toEqual(['/repo-force-cache']);

    const forcedListing = listProjectWorktrees(project, { force: true });
    await waitForListCallCount(2);
    listResolvers[1]([createdWorktree]);

    const forcedResult = await forcedListing;
    expect(forcedResult.map((entry) => entry.path)).toEqual(['/repo-feature']);
    expect(listCalls).toEqual(['/repo-force-cache', '/repo-force-cache']);
    const refreshedCachedResult = await listProjectWorktrees(project);
    expect(refreshedCachedResult.map((entry) => entry.path)).toEqual(['/repo-feature']);
    expect(listCalls).toEqual(['/repo-force-cache', '/repo-force-cache']);
  });

  test('forced refresh starts a new request instead of joining an older in-flight list', async () => {
    const project = { id: 'project-force-inflight', path: '/repo-force-inflight' };

    const initialListing = listProjectWorktrees(project);
    await waitForListCallCount(1);

    const forcedListing = listProjectWorktrees(project, { force: true });
    await waitForListCallCount(2);

    listResolvers[1]([createdWorktree]);
    const forcedResult = await forcedListing;
    expect(forcedResult.map((entry) => entry.path)).toEqual(['/repo-feature']);

    listResolvers[0]([]);
    await waitForListCallCount(3);
    listResolvers[2]([createdWorktree]);
    const initialResult = await initialListing;
    expect(initialResult.map((entry) => entry.path)).toEqual(['/repo-feature']);
    expect(listCalls).toEqual([
      '/repo-force-inflight',
      '/repo-force-inflight',
      '/repo-force-inflight',
    ]);
  });

  test('older completions do not replace a forced refresh result with stale topology', async () => {
    const project = { id: 'project-force-stale', path: '/repo-force-stale' };

    void listProjectWorktrees(project);
    await waitForListCallCount(1);

    const forcedListing = listProjectWorktrees(project, { force: true });
    await waitForListCallCount(2);
    listResolvers[1]([createdWorktree]);
    const forcedResult = await forcedListing;
    expect(forcedResult.map((entry) => entry.path)).toEqual(['/repo-feature']);

    listResolvers[0]([{ path: '/repo-stale', branch: 'stale', name: 'stale' }]);
    await waitForListCallCount(3);

    const cachedResult = await listProjectWorktrees(project);
    expect(cachedResult.map((entry) => entry.path)).toEqual(['/repo-feature']);
  });

  test('rejects when git worktree listing fails', async () => {
    const project = { id: 'project-force-failure', path: '/repo-force-failure' };

    const listing = listProjectWorktrees(project);
    await waitForListCallCount(1);
    listRejecters[0](new Error('git failed'));

    await expect(listing).rejects.toThrow('git failed');
  });

  test('rejects sustained invalidation explicitly, preserves the last cached result, and allows a later retry', async () => {
    const project = { id: 'project-force-convergence', path: '/repo-force-convergence' };
    const oldWorktree = [{ path: '/repo-old', branch: 'old', name: 'old' } satisfies WorktreeListEntry];
    const scriptedResolvers = new Map<number, (value: WorktreeListEntry[]) => void>();
    let recoveryReadsAllowed = false;

    listImplementation = () => {
      const callNumber = listCalls.length;
      if (callNumber === 8 && !recoveryReadsAllowed) {
        return Promise.reject(new Error('unexpected extra read'));
      }
      return new Promise<WorktreeListEntry[]>((resolve) => {
        scriptedResolvers.set(callNumber, resolve);
      });
    };

    const seededListing = listProjectWorktrees(project);
    await waitForListCallCount(1);
    scriptedResolvers.get(1)?.(oldWorktree);
    expect((await seededListing).map((entry) => entry.path)).toEqual(['/repo-old']);

    const unstableListing = listProjectWorktrees(project, { force: true });
    await waitForListCallCount(2);

    const forcedRefreshA = listProjectWorktrees(project, { force: true });
    await waitForListCallCount(3);
    scriptedResolvers.get(3)?.([createdWorktree]);
    expect((await forcedRefreshA).map((entry) => entry.path)).toEqual(['/repo-feature']);
    scriptedResolvers.get(2)?.([{ path: '/repo-stale-a', branch: 'stale-a', name: 'stale-a' }]);
    await waitForListCallCount(4);

    const forcedRefreshB = listProjectWorktrees(project, { force: true });
    await waitForListCallCount(5);
    scriptedResolvers.get(5)?.([createdWorktree]);
    expect((await forcedRefreshB).map((entry) => entry.path)).toEqual(['/repo-feature']);
    scriptedResolvers.get(4)?.([{ path: '/repo-stale-b', branch: 'stale-b', name: 'stale-b' }]);
    await waitForListCallCount(6);

    const forcedRefreshC = listProjectWorktrees(project, { force: true });
    await waitForListCallCount(7);
    scriptedResolvers.get(7)?.([createdWorktree]);
    expect((await forcedRefreshC).map((entry) => entry.path)).toEqual(['/repo-feature']);
    scriptedResolvers.get(6)?.([{ path: '/repo-stale-c', branch: 'stale-c', name: 'stale-c' }]);

    await expect(unstableListing).rejects.toThrow('Worktree list did not converge');
    expect(listCalls).toHaveLength(7);

    const cachedResult = await listProjectWorktrees(project);
    expect(cachedResult.map((entry) => entry.path)).toEqual(['/repo-feature']);
    expect(listCalls).toHaveLength(7);

    recoveryReadsAllowed = true;
    const recoveredListing = listProjectWorktrees(project, { force: true });
    await waitForListCallCount(8);
    scriptedResolvers.get(8)?.([createdWorktree]);
    expect((await recoveredListing).map((entry) => entry.path)).toEqual(['/repo-feature']);
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

  test('does not duplicate a worktree already published by discovery', async () => {
    const discovered: WorktreeMetadata = {
      path: '/repo-feature',
      projectDirectory: '/repo',
      branch: 'feature',
      label: 'feature',
      worktreeStatus: 'ready',
    };
    sessionState.availableWorktrees = [discovered];
    sessionState.availableWorktreesByProject = new Map([['/repo', [discovered]]]);

    await createWorktree({ id: 'project-linked', path: '/repo-linked' }, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    });

    expect(sessionState.availableWorktrees.map((worktree) => worktree.path)).toEqual(['/repo-feature']);
    expect(sessionState.availableWorktreesByProject.get('/repo')?.map((worktree) => worktree.path)).toEqual(['/repo-feature']);
    expect(sessionState.availableWorktreesByProject.has('/repo-linked')).toBe(false);
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

  test('removes a worktree from sidebar topology owned by another registered checkout', async () => {
    const removed: WorktreeMetadata = {
      path: '/worktrees/removed',
      projectDirectory: '/repo',
      branch: 'removed',
      label: 'removed',
    };
    const sibling: WorktreeMetadata = {
      path: '/worktrees/sibling',
      projectDirectory: '/repo',
      branch: 'sibling',
      label: 'sibling',
    };
    const unrelatedEntries: WorktreeMetadata[] = [{
      path: '/other/worktree',
      projectDirectory: '/other',
      branch: 'other',
      label: 'other',
    }];
    sessionState.availableWorktreesByProject = new Map([
      ['/worktrees/configured', [removed, sibling]],
      ['/other', unrelatedEntries],
    ]);
    sessionState.availableWorktrees = [removed, sibling, ...unrelatedEntries];
    sessionState.worktreeMetadata = new Map([
      ['removed-session', removed],
      ['sibling-session', sibling],
    ]);

    await removeProjectWorktree({ id: 'path:/repo', path: '/repo' }, removed);

    expect(sessionState.availableWorktreesByProject.get('/worktrees/configured')).toEqual([sibling]);
    expect(sessionState.availableWorktreesByProject.get('/other')).toBe(unrelatedEntries);
    expect(sessionState.availableWorktrees).toEqual([sibling, ...unrelatedEntries]);
    expect(sessionState.worktreeMetadata.has('removed-session')).toBe(false);
    expect(sessionState.worktreeMetadata.get('sibling-session')).toBe(sibling);
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

describe('partitionWorktreesByRegisteredProject', () => {
  const worktree = (path: string, projectDirectory = '/repo'): WorktreeMetadata => {
    const label = path.split('/').pop() ?? path;
    return { path, projectDirectory, branch: label, label };
  };

  test('assigns shared topology to the primary project and omits configured worktree projects', () => {
    const projects = [
      { path: '/repo' },
      { path: '/worktrees/alpha' },
      { path: '/worktrees/beta' },
    ];
    const topology = new Map<string, WorktreeMetadata[]>([
      ['/repo', [
        worktree('/worktrees/alpha'),
        worktree('/worktrees/beta'),
        worktree('/worktrees/loose'),
      ]],
      ['/worktrees/alpha', [
        worktree('/repo'),
        worktree('/worktrees/beta'),
        worktree('/worktrees/loose'),
      ]],
      ['/worktrees/beta', [
        worktree('/repo'),
        worktree('/worktrees/alpha'),
        worktree('/worktrees/loose'),
      ]],
    ]);

    const result = partitionWorktreesByRegisteredProject(projects, topology);

    expect([...result.keys()]).toEqual(['/repo']);
    expect(result.get('/repo')?.map((entry) => entry.path)).toEqual(['/worktrees/loose']);
  });

  test('uses the first configured checkout when the primary project is not configured', () => {
    const projects = [
      { path: '/worktrees/alpha' },
      { path: '/worktrees/beta' },
    ];
    const topology = new Map<string, WorktreeMetadata[]>([
      ['/worktrees/beta', [
        worktree('/repo'),
        worktree('/worktrees/alpha'),
        worktree('/worktrees/loose'),
      ]],
      ['/worktrees/alpha', [
        worktree('/repo'),
        worktree('/worktrees/beta'),
        worktree('/worktrees/loose'),
      ]],
    ]);

    const result = partitionWorktreesByRegisteredProject(projects, topology);

    expect([...result.keys()]).toEqual(['/worktrees/alpha']);
    expect(result.get('/worktrees/alpha')?.map((entry) => entry.path)).toEqual([
      '/repo',
      '/worktrees/loose',
    ]);
  });

  test('keeps primary ownership when topology comes from another configured checkout', () => {
    const projects = [
      { path: '/repo' },
      { path: '/worktrees/alpha' },
    ];
    const topology = new Map<string, WorktreeMetadata[]>([
      ['/worktrees/alpha', [
        worktree('/repo'),
        worktree('/worktrees/loose'),
      ]],
    ]);

    const result = partitionWorktreesByRegisteredProject(projects, topology);

    expect([...result.keys()]).toEqual(['/repo']);
    expect(result.get('/repo')?.map((entry) => entry.path)).toEqual(['/worktrees/loose']);
  });
});

describe('replaceRepositoryWorktrees', () => {
  test('replaces every bucket that belongs to the refreshed repository', () => {
    const metadata = (path: string, projectDirectory: string): WorktreeMetadata => ({
      path,
      projectDirectory,
      branch: 'feature',
      label: 'feature',
    });
    const staleRoot = metadata('/repo-stale', '/repo');
    const staleLinked = metadata('/repo-linked-stale', '/repo');
    const refreshed = metadata('/repo-fresh', '/repo');
    const topology = new Map<string, WorktreeMetadata[]>([
      ['/repo', [staleRoot]],
      ['/repo-linked', [staleLinked]],
      ['/other', [metadata('/other-worktree', '/other')]],
    ]);

    const result = replaceRepositoryWorktrees(topology, '/repo-linked', [refreshed]);

    expect(result.get('/repo')?.map((worktree) => worktree.path)).toEqual(['/repo-fresh']);
    expect(result.get('/repo-linked')?.map((worktree) => worktree.path)).toEqual(['/repo-fresh']);
    expect(result.get('/other')?.map((worktree) => worktree.path)).toEqual(['/other-worktree']);
  });
});

describe('preserveClientTrackedWorktreeStatus', () => {
  const metadata = (path: string, status: WorktreeMetadata['worktreeStatus'], source?: WorktreeMetadata['worktreeSource']): WorktreeMetadata => ({
    path,
    projectDirectory: '/repo',
    branch: 'feature',
    label: 'feature',
    worktreeStatus: status,
    ...(source ? { worktreeSource: source } : {}),
  });

  test('keeps pending and invalid statuses this client tracks over a ready listing', () => {
    const published = new Map<string, WorktreeMetadata[]>([
      ['/repo', [metadata('/repo-pending', 'pending', 'created-for-session'), metadata('/repo-invalid', 'invalid'), metadata('/repo-done', 'ready')]],
    ]);
    const refreshed = new Map<string, WorktreeMetadata[]>([
      ['/repo', [metadata('/repo-pending', 'ready'), metadata('/repo-invalid', 'ready'), metadata('/repo-done', 'ready')]],
      ['/other', [metadata('/other-feature', 'ready')]],
    ]);

    const result = preserveClientTrackedWorktreeStatus(refreshed, published);

    expect(result.get('/repo')?.map((worktree) => [worktree.path, worktree.worktreeStatus, worktree.worktreeSource])).toEqual([
      ['/repo-pending', 'pending', 'created-for-session'],
      ['/repo-invalid', 'invalid', undefined],
      ['/repo-done', 'ready', undefined],
    ]);
    expect(result.get('/other')).toBe(refreshed.get('/other'));
  });

  test('lets git win when the directory is gone and returns the same map when nothing is tracked', () => {
    const published = new Map<string, WorktreeMetadata[]>([['/repo', [metadata('/repo-pending', 'pending')]]]);
    const missing = new Map<string, WorktreeMetadata[]>([['/repo', [metadata('/repo-pending', 'missing')]]]);
    expect(preserveClientTrackedWorktreeStatus(missing, published).get('/repo')?.[0]?.worktreeStatus).toBe('missing');

    const untracked = new Map<string, WorktreeMetadata[]>([['/repo', [metadata('/repo-done', 'ready')]]]);
    const refreshed = new Map<string, WorktreeMetadata[]>([['/repo', [metadata('/repo-done', 'ready')]]]);
    expect(preserveClientTrackedWorktreeStatus(refreshed, untracked)).toBe(refreshed);
  });
});

describe('worktreeManager fork remote payload wiring', () => {
  beforeEach(() => {
    listCalls.length = 0;
    listResolvers.length = 0;
    listRejecters.length = 0;
    createPayloads.length = 0;
    validatePayloads.length = 0;
    bootstrapWatcherCalls.length = 0;
    bootstrapWatcherOptions.length = 0;
    createdWorktreeResult = createdWorktree;
    sessionState.availableWorktreesByProject = new Map();
    sessionState.availableWorktrees = [];
    sessionState.worktreeMetadata = new Map();
    attachmentState.attachments = new Map();
  });

  test('validate and create forward only the exact change-request source request', async () => {
    const project = { id: 'project-1', path: '/repo' };
    const args = {
      mode: 'existing' as const,
      branchName: 'feature/login',
      worktreeName: 'pr-42',
      existingBranch: 'remotes/pr-alice/feature/login',
      changeRequestSource: {
        context: { provider: 'github' as const, instance: 'github.com', directory: '/repo', repositoryId: 'repo_one', accountId: 'account_one', bindingRevision: 2, primaryRemote: 'origin' },
        project: { id: 'acme/app', owner: 'acme', name: 'app' },
        number: 42,
        expectedHeadSha: '1111111111111111111111111111111111111111',
        requestedRemoteName: 'pr-alice',
      },
      expectedRevision: '1111111111111111111111111111111111111111',
    };

    const validation = await validateWorktreeCreate(project, args);
    expect(validation.ok).toBe(true);
    expect(validatePayloads).toHaveLength(1);
    expect(validatePayloads[0]).toEqual(args);

    await createWorktree(project, {
      ...args,
      returnAfterDirectoryCreated: true,
    });
    expect(createPayloads).toHaveLength(1);
    expect(createPayloads[0]).toEqual({ ...args, returnAfterDirectoryCreated: true });
  });
});

describe('worktreeManager remote deletion ordering', () => {
  const endpoint = { displayUrl: 'https://example.com/team/repo.git', fingerprint: 'a'.repeat(64) };
  const bindingRead: SourceControlBindingRead = {
    status: 'bound',
    repository: {
      repositoryId: 'repository-one', configRevision: 'config-one', bare: false,
      remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }],
    },
    revision: 3,
    binding: {
      repositoryId: 'repository-one', revision: 3, state: 'bound', configRevision: 'config-one',
      providers: [], auxiliary: [],
      remotes: [{ name: 'origin', fetch: endpoint, push: endpoint, mode: 'managed', credentialId: 'credential-one', readiness: 'ready' }],
    },
  };
  const plan: GitNetworkOperationPlan = {
    operationId: 'operation-delete',
    runtimeIdentity: { id: 'runtime-one', platform: 'web' },
    transport: { mode: 'managed', verification: { status: 'verified', method: 'credential' } },
    target: {
      operation: 'delete-remote-branch', repositoryId: 'repository-one', bindingRevision: 3,
      configRevision: 'config-one', remote: { name: 'origin', endpoint },
      destinationRef: 'refs/heads/feature/delete-me',
    },
    completedSteps: [],
    state: 'planned',
  };

  beforeEach(() => {
    removeCalls.length = 0;
  });

  for (const state of ['failed', 'outcome-unknown'] as const) {
    test(`does not remove the local worktree after ${state} remote deletion`, async () => {
      const terminalOperation = (): GitNetworkOperation => state === 'failed'
        ? { ...plan, state, error: { code: 'TRANSPORT_FAILED', message: 'Remote deletion did not complete' } }
        : { ...plan, state, error: { code: 'OUTCOME_UNKNOWN', message: 'Remote deletion did not complete' } };
      await expect(removeProjectWorktree(
        { id: 'project-one', path: '/repo' },
        { path: '/repo-feature', branch: 'feature/delete-me', projectDirectory: '/repo', label: 'delete-me' },
        {
          deleteRemoteBranch: true,
          deleteLocalBranch: true,
          remoteName: 'origin',
          network: {
            sourceControl: { repositoryBinding: async () => bindingRead },
            git: {
              planNetworkOperation: async () => plan,
              executeNetworkOperation: async () => terminalOperation(),
              getNetworkOperation: async () => terminalOperation(),
            },
          },
        },
      )).rejects.toThrow('Remote deletion did not complete');

      expect(removeCalls).toEqual([]);
    });
  }
});

describe('worktreeManager missing worktrees', () => {
  beforeEach(() => {
    listCalls.length = 0;
    listResolvers.length = 0;
    listRejecters.length = 0;
    listImplementation = undefined;
  });

  test('keeps a prunable worktree in the topology as missing instead of dropping it', async () => {
    listImplementation = async () => [
      { path: '/repo-missing/.worktrees/alive', branch: 'alive', head: 'abc', name: 'alive' },
      { path: '/repo-missing/.worktrees/gone', branch: 'gone', head: 'def', name: 'gone', prunable: true },
    ];

    const result = await listProjectWorktrees({ id: 'project-missing', path: '/repo-missing' }, { force: true });

    expect(result.map((entry) => [entry.path, entry.worktreeStatus])).toEqual([
      ['/repo-missing/.worktrees/alive', 'ready'],
      ['/repo-missing/.worktrees/gone', 'missing'],
    ]);
  });

  test('a worktree that changes only its status still counts as a topology change', () => {
    const ready: WorktreeMetadata = { path: '/repo/.worktrees/a', projectDirectory: '/repo', branch: 'a', label: 'a', worktreeStatus: 'ready' };
    const missing: WorktreeMetadata = { ...ready, worktreeStatus: 'missing' };

    expect(worktreeMapsEqual(new Map([['/repo', [ready]]]), new Map([['/repo', [ready]]]))).toBe(true);
    expect(worktreeMapsEqual(new Map([['/repo', [ready]]]), new Map([['/repo', [missing]]]))).toBe(false);
  });

});
