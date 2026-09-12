import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';

type WorktreeListEntry = { path: string; branch: string };

const listCalls: string[] = [];
let listImplementation: (directory: string) => Promise<WorktreeListEntry[]> = () => Promise.resolve([]);

type SessionState = {
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  availableWorktrees: WorktreeMetadata[];
};
const sessionState: SessionState = {
  availableWorktreesByProject: new Map(),
  availableWorktrees: [],
};
let setStateCalls = 0;

const projects = [
  { id: 'repo', path: '/repo' },
  { id: 'other', path: '/other' },
];

mock.module('@/lib/openchamberConfig', () => ({ substituteCommandVariables: (command: string) => command }));
mock.module('@/components/ui', () => ({ toast: { warning: () => undefined } }));
mock.module('@/lib/i18n', () => ({ formatMessage: () => '', useI18nStore: { getState: () => ({ dictionary: {} }) } }));
mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  clearWorktreeBootstrapState: mock(),
  markWorktreeBootstrapPending: mock(),
  setWorktreeBootstrapState: mock(),
  startWorktreeBootstrapWatcher: mock(),
}));
mock.module('@/sync/session-worktree-store', () => ({ useSessionWorktreeStore: { setState: mock() } }));
mock.module('@/lib/worktrees/worktreeStatus', () => ({
  invalidateResolvedProjectRootCache: mock(),
  resolveProjectRoot: (directory: string) => Promise.resolve(directory),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => sessionState,
    setState: (patch: Partial<typeof sessionState>) => {
      setStateCalls += 1;
      Object.assign(sessionState, patch);
    },
  },
}));
mock.module('@/lib/gitApi', () => ({
  deleteRemoteBranch: mock(),
  git: {
    worktree: {
      list: (directory: string) => {
        listCalls.push(directory);
        return listImplementation(directory);
      },
      create: mock(),
      validate: mock(),
      remove: mock(),
    },
  },
}));
// The real resolver consults stores; the contract exercised here is that any
// directory it maps to a project is refreshed once for that project.
mock.module('@/lib/worktreeSessionCreator', () => ({
  resolveProjectRef: (directory: string) => {
    if (directory === '/repo' || directory === '/repo-feature') return { id: 'repo', path: '/repo' };
    if (directory === '/other') return { id: 'other', path: '/other' };
    return null;
  },
}));

const { refreshWorktreeTopologyForChange, resolveProjectsForWorktreeChange } = await import('./worktreeTopologyRefresh');

const metadata = (path: string, projectDirectory: string, status: WorktreeMetadata['worktreeStatus'] = 'ready'): WorktreeMetadata => ({
  path,
  projectDirectory,
  branch: 'feature',
  label: 'feature',
  worktreeStatus: status,
});

describe('worktree topology refresh from control events', () => {
  beforeEach(() => {
    listCalls.length = 0;
    setStateCalls = 0;
    sessionState.availableWorktreesByProject = new Map([
      ['/repo', [metadata('/repo-stale', '/repo')]],
      ['/other', [metadata('/other-feature', '/other')]],
    ]);
    sessionState.availableWorktrees = [...sessionState.availableWorktreesByProject.values()].flat();
  });

  test('maps event directories onto registered projects once each', () => {
    expect(resolveProjectsForWorktreeChange(['/repo', '/repo-feature', '/unknown'])).toEqual([{ id: 'repo', path: '/repo' }]);
  });

  test('force-lists the affected project and replaces only its buckets', async () => {
    listImplementation = () => Promise.resolve([
      { path: '/repo', branch: 'main' },
      { path: '/repo-feature', branch: 'feature' },
    ]);

    await refreshWorktreeTopologyForChange(projects, ['/repo-feature']);

    expect(listCalls).toEqual(['/repo']);
    expect(sessionState.availableWorktreesByProject.get('/repo')?.map((worktree) => worktree.path)).toEqual(['/repo-feature']);
    expect(sessionState.availableWorktreesByProject.get('/other')?.map((worktree) => worktree.path)).toEqual(['/other-feature']);
    expect(sessionState.availableWorktrees.map((worktree) => worktree.path)).toEqual(['/repo-feature', '/other-feature']);
  });

  test('keeps the last known topology when the listing fails or the surface unmounted', async () => {
    listImplementation = () => Promise.reject(new Error('git failed'));
    await refreshWorktreeTopologyForChange(projects, ['/repo']);
    expect(setStateCalls).toBe(0);
    expect(sessionState.availableWorktreesByProject.get('/repo')?.map((worktree) => worktree.path)).toEqual(['/repo-stale']);

    listImplementation = () => Promise.resolve([{ path: '/repo', branch: 'main' }]);
    await refreshWorktreeTopologyForChange(projects, ['/repo'], () => true);
    expect(setStateCalls).toBe(0);
  });

  test('keeps a bootstrap status this client still tracks', async () => {
    sessionState.availableWorktreesByProject.set('/repo', [metadata('/repo-feature', '/repo', 'pending')]);
    listImplementation = () => Promise.resolve([
      { path: '/repo', branch: 'main' },
      { path: '/repo-feature', branch: 'feature' },
    ]);

    await refreshWorktreeTopologyForChange(projects, ['/repo']);

    expect(sessionState.availableWorktreesByProject.get('/repo')?.[0]?.worktreeStatus).toBe('pending');
  });
});
