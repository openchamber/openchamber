import { describe, expect, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  buildSessionWorktreeMenuTargets,
  commitDiscoveredRawWorktreesByProject,
  getSessionWorktreeMenuState,
  markRawWorktreesByProjectMutation,
  startSessionWorktreeMenuLoad,
} from './sessionWorktreeMenu';

const rawScope = (runtimeKey: string | null, entries: Array<[string, WorktreeMetadata[]]>) => ({
  current: {
    runtimeKey,
    revision: 0,
    worktreesByProject: new Map<string, WorktreeMetadata[]>(entries),
  },
});

const worktree = (overrides: Partial<WorktreeMetadata> = {}): WorktreeMetadata => ({
  path: '/repo-feature',
  projectDirectory: '/repo',
  branch: 'feature',
  label: 'feature',
  name: 'feature',
  worktreeStatus: 'ready',
  worktreeSource: 'existing',
  ...overrides,
});

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('buildSessionWorktreeMenuTargets', () => {
  test('adds the canonical main worktree, includes the current source, dedupes by path, and sorts linked targets', () => {
    const targets = buildSessionWorktreeMenuTargets({
      projectPath: '/repo-linked',
      discoveredWorktrees: [
        worktree({ path: '/repo-zebra', branch: 'zebra', label: 'zebra', name: 'zebra' }),
        worktree({ path: '/repo-alpha', branch: 'alpha', label: 'alpha', name: 'alpha' }),
        worktree({ path: '/repo-current', branch: 'current', label: 'current', name: 'current' }),
        worktree({ path: '/repo-alpha/', branch: 'alpha', label: 'alpha duplicate', name: 'alpha-duplicate' }),
      ],
      sourceDirectory: '/repo-current/',
      currentWorktree: worktree({
        path: '/repo-current',
        projectDirectory: '/repo',
        branch: 'current',
        label: 'Current branch',
      }),
    });

    expect(targets.map((target) => ({
      path: target.metadata.path,
      isPrimary: target.isPrimary,
      isCurrent: target.isCurrent,
    }))).toEqual([
      { path: '/repo', isPrimary: true, isCurrent: false },
      { path: '/repo-alpha', isPrimary: false, isCurrent: false },
      { path: '/repo-current', isPrimary: false, isCurrent: true },
      { path: '/repo-zebra', isPrimary: false, isCurrent: false },
    ]);
    expect(targets[0]?.metadata.worktreeStatus).toBe('ready');
    expect(targets[0]?.metadata.worktreeSource).toBe('existing');
  });

  test('prefers discovered primary metadata instead of synthetic fallback metadata', () => {
    const targets = buildSessionWorktreeMenuTargets({
      projectPath: '/repo-linked',
      discoveredWorktrees: [
        worktree({
          path: '/repo',
          projectDirectory: '/repo',
          branch: 'main',
          label: 'main',
          name: 'repo-primary',
          headState: 'branch',
        }),
      ],
      sourceDirectory: '/repo-linked',
      currentWorktree: worktree({
        path: '/repo-linked',
        projectDirectory: '/repo',
        branch: 'feature',
        label: 'feature',
      }),
    });

    expect(targets[0]?.isPrimary).toBe(true);
    expect(targets[0]?.metadata.path).toBe('/repo');
    expect(targets[0]?.metadata.branch).toBe('main');
    expect(targets[0]?.metadata.label).toBe('main');
    expect(targets[0]?.metadata.name).toBe('repo-primary');
    expect(targets[0]?.metadata.headState).toBe('branch');
  });

  test('sorts linked targets by effective compact label when branch is missing', () => {
    const targets = buildSessionWorktreeMenuTargets({
      projectPath: '/repo',
      discoveredWorktrees: [
        worktree({ path: '/repo-zed', branch: '', label: '', name: 'zed' }),
        worktree({ path: '/repo-alpha', branch: '', label: '', name: 'alpha' }),
        worktree({ path: '/repo-beta', branch: 'beta', label: 'beta', name: 'beta' }),
      ],
      sourceDirectory: '/repo-current',
      currentWorktree: worktree({ path: '/repo-current', projectDirectory: '/repo', branch: '', label: '', name: 'current' }),
    });

    expect(targets.map((target) => target.metadata.path)).toEqual([
      '/repo',
      '/repo-alpha',
      '/repo-beta',
      '/repo-current',
      '/repo-zed',
    ]);
  });

  test('uses the owning project root branch for a synthetic primary when git omits the queried checkout', () => {
    const targets = buildSessionWorktreeMenuTargets({
      projectPath: '/repo',
      discoveredWorktrees: [
        worktree({ path: '/repo-feature', projectDirectory: '/repo', branch: 'feature', label: 'feature' }),
      ],
      sourceDirectory: '/repo-feature',
      currentWorktree: worktree({ path: '/repo-feature', projectDirectory: '/repo', branch: 'feature', label: 'feature' }),
      projectRootBranch: 'main',
    });

    expect(targets[0]?.isPrimary).toBe(true);
    expect(targets[0]?.metadata.path).toBe('/repo');
    expect(targets[0]?.metadata.branch).toBe('main');
    expect(targets[0]?.metadata.label).toBe('main');
    expect(targets[0]?.metadata.headState).toBe('branch');
  });
});

describe('commitDiscoveredRawWorktreesByProject', () => {
  test('rejects an older aggregate commit after a newer targeted mutation and requests one bounded rediscovery', () => {
    const rawRef = rawScope('runtime-1', [
      ['/repo', [worktree({ path: '/repo-old', projectDirectory: '/repo', branch: 'old', label: 'old' })]],
    ]);
    const reruns: string[] = [];
    const published: Array<unknown> = [];
    const capturedRevision = rawRef.current.revision;

    markRawWorktreesByProjectMutation(rawRef, 'runtime-1');

    const committed = commitDiscoveredRawWorktreesByProject({
      rawWorktreesByProjectRef: rawRef,
      runtimeKey: 'runtime-1',
      capturedRevision,
      nextRawWorktreesByProject: new Map([
        ['/repo', [worktree({ path: '/repo-stale', projectDirectory: '/repo', branch: 'stale', label: 'stale' })]],
      ]),
      publishedWorktreesByProject: new Map(),
      partitionWorktreesByRegisteredProject: (_projects, worktreesByProject) => new Map(worktreesByProject),
      projects: [{ id: 'owner', path: '/repo' }],
      worktreeMapsEqual: () => false,
      recordWorktreesSeen: () => {},
      publishTopology: (next) => {
        published.push(next);
      },
      requestRediscovery: () => {
        reruns.push('rerun');
      },
      now: () => 123,
    });

    expect(committed).toBe(false);
    expect(reruns).toEqual(['rerun']);
    expect(rawRef.current.worktreesByProject.get('/repo')?.map((entry) => entry.path)).toEqual(['/repo-old']);
    expect(published).toEqual([]);
  });
});

describe('startSessionWorktreeMenuLoad', () => {
  test('returns cached targets immediately, forces only the owning project refresh, and publishes refreshed topology', async () => {
    const calls: Array<{ projectId: string; force: boolean }> = [];
    const published: Array<{ availableWorktrees: WorktreeMetadata[]; availableWorktreesByProject: Map<string, WorktreeMetadata[]> }> = [];
    const rawRef = rawScope('runtime-1', [
        ['/repo-linked', [worktree({ path: '/repo-existing', branch: 'existing', label: 'existing', name: 'existing' })]],
        ['/repo-other', [worktree({ path: '/other-worktree', projectDirectory: '/repo-other', branch: 'other', label: 'other', name: 'other' })]],
      ]);

    const load = startSessionWorktreeMenuLoad(
      {
        projectId: 'linked',
        sourceDirectory: '/repo-current',
        currentWorktree: worktree({ path: '/repo-current', branch: 'current', label: 'current' }),
      },
      {
        projects: [
          { id: 'linked', path: '/repo-linked' },
          { id: 'other', path: '/repo-other' },
        ],
        rawWorktreesByProjectRef: rawRef,
        getPublishedWorktreesByProject: () => new Map(),
        resolveProject: () => null,
        listProjectWorktrees: async (project, options) => {
          calls.push({ projectId: project.id, force: options.force });
          return [
            worktree({ path: '/repo-new', branch: 'aaa', label: 'aaa', name: 'aaa' }),
            worktree({ path: '/repo-current', branch: 'current', label: 'current', name: 'current' }),
          ];
        },
        partitionWorktreesByRegisteredProject: (_projects, worktreesByProject) => new Map(worktreesByProject),
        worktreeMapsEqual: () => false,
        recordWorktreesSeen: () => {},
        publishTopology: (next) => {
          published.push(next);
        },
        getRuntimeKey: () => 'runtime-1',
        now: () => 123,
        projectRootBranch: null,
      },
    );

    expect(load.cachedTargets.map((target) => target.metadata.path)).toEqual([
      '/repo',
      '/repo-current',
      '/repo-existing',
    ]);

    const freshTargets = await load.refreshTargets;

    expect(calls).toEqual([{ projectId: 'linked', force: true }]);
    expect(freshTargets.map((target) => target.metadata.path)).toEqual([
      '/repo',
      '/repo-new',
      '/repo-current',
    ]);
    expect(rawRef.current.worktreesByProject.get('/repo-linked')?.map((entry) => entry.path)).toEqual([
      '/repo-new',
      '/repo-current',
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]?.availableWorktreesByProject.get('/repo-linked')?.map((entry) => entry.path)).toEqual([
      '/repo-new',
      '/repo-current',
    ]);
  });

  test('rejects refresh failures without mutating topology and keeps cached targets available for the menu', async () => {
    const published: Array<unknown> = [];
    const existing = worktree({ path: '/repo-existing', branch: 'existing', label: 'existing', name: 'existing' });
    const rawRef = rawScope('runtime-1', [
        ['/repo-linked', [existing]],
      ]);

    const load = startSessionWorktreeMenuLoad(
      {
        projectId: 'linked',
        sourceDirectory: '/repo-current',
        currentWorktree: worktree({ path: '/repo-current', branch: 'current', label: 'current' }),
      },
      {
        projects: [{ id: 'linked', path: '/repo-linked' }],
        rawWorktreesByProjectRef: rawRef,
        getPublishedWorktreesByProject: () => new Map([['/repo-linked', [existing]]]),
        resolveProject: () => null,
        listProjectWorktrees: async () => {
          throw new Error('git failed');
        },
        partitionWorktreesByRegisteredProject: (_projects, worktreesByProject) => new Map(worktreesByProject),
        worktreeMapsEqual: () => false,
        recordWorktreesSeen: () => {},
        publishTopology: (next) => {
          published.push(next);
        },
        getRuntimeKey: () => 'runtime-1',
        now: () => 123,
        projectRootBranch: null,
      },
    );

    expect(load.cachedTargets.map((target) => target.metadata.path)).toEqual([
      '/repo',
      '/repo-current',
      '/repo-existing',
    ]);
    const refreshError = await load.refreshTargets.catch((error) => error);
    expect(refreshError).toBeInstanceOf(Error);
    expect(refreshError.message).toBe('git failed');
    expect(rawRef.current.worktreesByProject.get('/repo-linked')).toEqual([existing]);
    expect(published).toEqual([]);
  });

  test('seeds an empty raw scope from published topology so a failed first refresh preserves prior topology', async () => {
    const publishedTopology = new Map<string, WorktreeMetadata[]>([
      ['/repo-linked', [worktree({ path: '/repo-existing', branch: 'existing', label: 'existing', name: 'existing' })]],
    ]);
    const rawRef = rawScope(null, []);

    const load = startSessionWorktreeMenuLoad(
      {
        projectId: 'linked',
        sourceDirectory: '/repo-current',
        currentWorktree: worktree({ path: '/repo-current', branch: 'current', label: 'current' }),
      },
      {
        projects: [{ id: 'linked', path: '/repo-linked' }],
        rawWorktreesByProjectRef: rawRef,
        getPublishedWorktreesByProject: () => publishedTopology,
        resolveProject: () => null,
        listProjectWorktrees: async () => {
          throw new Error('git failed');
        },
        partitionWorktreesByRegisteredProject: (_projects, worktreesByProject) => new Map(worktreesByProject),
        worktreeMapsEqual: () => true,
        recordWorktreesSeen: () => {},
        publishTopology: () => {
          throw new Error('should not publish on failed refresh');
        },
        getRuntimeKey: () => 'runtime-1',
        now: () => 123,
        projectRootBranch: null,
      },
    );

    expect(load.cachedTargets.map((target) => target.metadata.path)).toEqual([
      '/repo',
      '/repo-current',
      '/repo-existing',
    ]);
    const refreshError = await load.refreshTargets.catch((error) => error);
    expect(refreshError).toBeInstanceOf(Error);
    expect(refreshError.message).toBe('git failed');
    expect(rawRef.current.runtimeKey).toBe('runtime-1');
    expect(rawRef.current.worktreesByProject.get('/repo-linked')?.map((entry) => entry.path)).toEqual(['/repo-existing']);
  });

  test('applies a non-owner shared-repository refresh to the owner raw and published topology', async () => {
    const published: Array<{ availableWorktreesByProject: Map<string, WorktreeMetadata[]> }> = [];
    const ownerExisting = worktree({ path: '/repo-old', branch: 'old', label: 'old', name: 'old' });
    const rawRef = rawScope('runtime-1', [
      ['/repo', [ownerExisting]],
      ['/repo-linked', [worktree({ path: '/repo-other-stale', branch: 'stale', label: 'stale', name: 'stale' })]],
    ]);

    const load = startSessionWorktreeMenuLoad(
      {
        projectId: 'linked',
        sourceDirectory: '/repo-linked',
        currentWorktree: worktree({ path: '/repo-linked', projectDirectory: '/repo', branch: 'feature', label: 'feature' }),
      },
      {
        projects: [
          { id: 'owner', path: '/repo' },
          { id: 'linked', path: '/repo-linked' },
        ],
        rawWorktreesByProjectRef: rawRef,
        getPublishedWorktreesByProject: () => new Map([['/repo', [ownerExisting]]]),
        resolveProject: () => null,
        listProjectWorktrees: async () => [
          worktree({ path: '/repo-new', projectDirectory: '/repo', branch: 'new', label: 'new', name: 'new' }),
        ],
        partitionWorktreesByRegisteredProject: (projects, worktreesByProject) => {
          const ownerPath = projects[0]!.path;
          return new Map([[ownerPath, worktreesByProject.get(ownerPath) ?? []]]);
        },
        worktreeMapsEqual: () => false,
        recordWorktreesSeen: () => {},
        publishTopology: (next) => {
          published.push({ availableWorktreesByProject: next.availableWorktreesByProject });
        },
        getRuntimeKey: () => 'runtime-1',
        now: () => 123,
        projectRootBranch: null,
      },
    );

    await load.refreshTargets;

    expect(rawRef.current.worktreesByProject.get('/repo')?.map((entry) => entry.path)).toEqual(['/repo-new']);
    expect(published[0]?.availableWorktreesByProject.get('/repo')?.map((entry) => entry.path)).toEqual(['/repo-new']);
  });

  test('re-seeds raw topology on runtime change and ignores stale completions', async () => {
    let runtimeKey = 'runtime-2';
    const refreshDeferred = createDeferred<WorktreeMetadata[]>();
    const published: Array<unknown> = [];
    const rawRef = rawScope('runtime-1', [
      ['/old-runtime-repo', [worktree({ path: '/old-runtime-worktree', projectDirectory: '/old-runtime-repo' })]],
    ]);
    const publishedCurrentRuntime = new Map<string, WorktreeMetadata[]>([
      ['/repo-linked', [worktree({ path: '/repo-existing', branch: 'existing', label: 'existing', name: 'existing' })]],
    ]);

    const load = startSessionWorktreeMenuLoad(
      {
        projectId: 'linked',
        sourceDirectory: '/repo-current',
        currentWorktree: worktree({ path: '/repo-current', branch: 'current', label: 'current' }),
      },
      {
        projects: [{ id: 'linked', path: '/repo-linked' }],
        rawWorktreesByProjectRef: rawRef,
        getPublishedWorktreesByProject: () => publishedCurrentRuntime,
        resolveProject: () => null,
        listProjectWorktrees: async () => refreshDeferred.promise,
        partitionWorktreesByRegisteredProject: (_projects, worktreesByProject) => new Map(worktreesByProject),
        worktreeMapsEqual: () => false,
        recordWorktreesSeen: () => {},
        publishTopology: (next) => {
          published.push(next);
        },
        getRuntimeKey: () => runtimeKey,
        now: () => 123,
        projectRootBranch: null,
      },
    );

    expect(load.cachedTargets.map((target) => target.metadata.path)).toEqual([
      '/repo',
      '/repo-current',
      '/repo-existing',
    ]);
    expect(rawRef.current.runtimeKey).toBe('runtime-2');
    expect(rawRef.current.worktreesByProject.get('/repo-linked')?.map((entry) => entry.path)).toEqual(['/repo-existing']);

    runtimeKey = 'runtime-3';
    refreshDeferred.resolve([worktree({ path: '/repo-new', projectDirectory: '/repo', branch: 'new', label: 'new', name: 'new' })]);

    const refreshError = await load.refreshTargets.catch((error) => error);
    expect(refreshError).toBeInstanceOf(Error);
    expect(refreshError.message).toBe('Runtime changed during worktree refresh');
    expect(rawRef.current.runtimeKey).toBe('runtime-2');
    expect(rawRef.current.worktreesByProject.get('/repo-linked')?.map((entry) => entry.path)).toEqual(['/repo-existing']);
    expect(published).toEqual([]);
  });

  test('falls back to resolving the owning configured project from the source directory when projectId is missing', async () => {
    const calls: string[] = [];
    const load = startSessionWorktreeMenuLoad(
      {
        projectId: null,
        sourceDirectory: '/repo-feature',
        currentWorktree: worktree({ path: '/repo-feature', projectDirectory: '/repo', branch: 'feature', label: 'feature' }),
      },
      {
        projects: [{ id: 'owner', path: '/repo' }],
        rawWorktreesByProjectRef: rawScope('runtime-1', []),
        getPublishedWorktreesByProject: () => new Map(),
        resolveProject: (directory) => {
          calls.push(directory);
          return { id: 'owner', path: '/repo' };
        },
        listProjectWorktrees: async (project) => [
          worktree({ path: '/repo-another', projectDirectory: project.path, branch: 'another', label: 'another', name: 'another' }),
        ],
        partitionWorktreesByRegisteredProject: (_projects, worktreesByProject) => new Map(worktreesByProject),
        worktreeMapsEqual: () => false,
        recordWorktreesSeen: () => {},
        publishTopology: () => {},
        getRuntimeKey: () => 'runtime-1',
        now: () => 123,
        projectRootBranch: 'main',
      },
    );

    expect(calls).toEqual(['/repo-feature']);
    expect(load.cachedTargets.map((target) => target.metadata.path)).toEqual(['/repo', '/repo-feature']);
    const refreshTargets = await load.refreshTargets;
    expect(refreshTargets.map((target) => ({
      path: target.metadata.path,
      branch: target.metadata.branch,
    }))).toEqual([
      { path: '/repo', branch: 'main' },
      { path: '/repo-another', branch: 'another' },
      { path: '/repo-feature', branch: 'feature' },
    ]);
  });
});

describe('getSessionWorktreeMenuState', () => {
  test('keeps the new worktree action available when refresh fails without cached targets', () => {
    expect(getSessionWorktreeMenuState({
      targets: [],
      isRefreshing: false,
      loadFailed: true,
    })).toEqual({
      refreshState: 'error',
      showNewWorktreeAction: true,
    });
  });
});
