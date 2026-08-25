import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installHookTestDom } from '../test-utils/testDom';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';

type Event =
  | { type: 'scheduled-task-ran' }
  | { type: 'session-created'; directory: string };

type LifecycleState = {
  demands: Array<{ owner: string; directories: string[] }>;
  clearedOwners: string[];
  globalRefreshes: number;
  directoryRefreshes: string[][];
  cleanupInputs: Array<{ enabled: boolean; hasAuthoritativeGlobalSessions: boolean; sessionCount: number; sessions: unknown[] }>;
  listener: ((event: Event) => void) | null;
  subscriptions: number;
  unsubscriptions: number;
};
const state: LifecycleState = {
  demands: [],
  clearedOwners: [],
  globalRefreshes: 0,
  directoryRefreshes: [],
  cleanupInputs: [],
  listener: null,
  subscriptions: 0,
  unsubscriptions: 0,
};
const childStores = {
  setBootstrapDemand: (owner: string, demands: Array<{ directory: string }>) => {
    state.demands.push({ owner, directories: demands.map((demand) => demand.directory) });
  },
  clearBootstrapDemand: (owner: string) => state.clearedOwners.push(owner),
};
type GlobalSessionsState = { activeSessions: never[]; archivedSessions: never[]; status: 'ready' };
const globalSessions: GlobalSessionsState = { activeSessions: [], archivedSessions: [], status: 'ready' };

mock.module('@/sync/sync-context', () => ({
  useChildStoreManager: () => childStores,
}));
mock.module('@/sync/sync-refs', () => ({ getAllSyncSessions: () => [] }));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: <T,>(selector: (value: GlobalSessionsState) => T): T => selector(globalSessions),
  refreshGlobalSessions: () => { state.globalRefreshes += 1; },
  refreshGlobalSessionsForDirectories: (directories: string[]) => { state.directoryRefreshes.push(directories); },
}));
mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: Event) => void) => {
    state.subscriptions += 1;
    state.listener = listener;
    return () => {
      state.unsubscriptions += 1;
      state.listener = null;
    };
  },
}));
mock.module('./useAuthoritativeSessionCleanup', () => ({
  useAuthoritativeSessionCleanup: (input: { enabled: boolean; hasAuthoritativeGlobalSessions: boolean; sessions: unknown[] }) => {
    state.cleanupInputs.push({
      enabled: input.enabled,
      hasAuthoritativeGlobalSessions: input.hasAuthoritativeGlobalSessions,
      sessionCount: input.sessions.length,
      sessions: input.sessions,
    });
  },
}));

const { useSessionListSync } = await import('./useSessionListSync');

const projects = [{ id: 'project', path: '/project' }];
const worktree: WorktreeMetadata = { path: '/worktree', projectDirectory: '/project', branch: 'feature', label: 'feature' };

const LifecycleProbe: React.FC<{ isVSCode: boolean }> = ({ isVSCode }) => {
  useSessionListSync({ isVSCode });
  return null;
};

const LifecycleHarness: React.FC<{ isVSCode: boolean; branch: 'hidden' | 'visible' | 'compact-sessions' | 'compact-chat' | 'expanded' }> = ({ isVSCode, branch }) => <>
  <LifecycleProbe isVSCode={isVSCode} />
  <span>{branch}</span>
</>;

describe('useSessionListSync', () => {
  let root: Root;
  let dom: ReturnType<typeof installHookTestDom>;

  beforeEach(() => {
    state.demands = [];
    state.clearedOwners = [];
    state.globalRefreshes = 0;
    state.directoryRefreshes = [];
    state.cleanupInputs = [];
    state.listener = null;
    state.subscriptions = 0;
    state.unsubscriptions = 0;
    dom = installHookTestDom();
    root = createRoot(dom.container);
    useProjectsStore.setState({ projects, activeProjectId: 'project' });
    useDirectoryStore.setState({ currentDirectory: '/project' });
    useSessionUIStore.setState({ currentSessionDirectory: null, availableWorktreesByProject: new Map() });
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.restore();
  });

  test('leaves initial global refresh to the root poller while publishing complete demand', () => {
    act(() => useSessionUIStore.setState({ availableWorktreesByProject: new Map([['/project', [worktree]]]) }));
    act(() => root.render(<LifecycleProbe isVSCode={false} />));

    expect(state.globalRefreshes).toBe(0);
    expect(state.demands).toHaveLength(1);
    expect(state.demands[0]?.directories).toEqual(['/project', '/worktree']);
    expect(state.directoryRefreshes).toEqual([]);
    expect(state.subscriptions).toBe(1);
    expect(state.cleanupInputs.at(-1)).toEqual({ enabled: true, hasAuthoritativeGlobalSessions: true, sessionCount: 0, sessions: [] });
  });

  test('refreshes every VS Code directory on first mount and only topology additions afterward', () => {
    act(() => root.render(<LifecycleProbe isVSCode />));
    act(() => useProjectsStore.setState({ projects: [...projects, { id: 'added', path: '/added' }] }));

    expect(state.directoryRefreshes).toEqual([['/project'], ['/added']]);
  });

  test('coalesces control events and clears the listener, timeout, and demand on unmount', async () => {
    act(() => root.render(<LifecycleProbe isVSCode={false} />));
    state.listener?.({ type: 'session-created', directory: '/created-a' });
    state.listener?.({ type: 'session-created', directory: '/created-b' });
    state.listener?.({ type: 'scheduled-task-ran' });

    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(state.globalRefreshes).toBe(1);
    expect(state.directoryRefreshes).toEqual([]);

    const owner = state.demands[0]?.owner;
    act(() => root.unmount());
    expect(state.unsubscriptions).toBe(1);
    expect(state.clearedOwners).toEqual([owner]);
  });

  test('does not duplicate lifecycle ownership when a hidden MainLayout or compact VS Code view rerenders', () => {
    act(() => root.render(<LifecycleProbe isVSCode={false} />));
    const cleanupSessions = state.cleanupInputs.at(-1)?.sessions;
    act(() => root.render(<LifecycleProbe isVSCode={false} />));
    expect(state.globalRefreshes).toBe(0);
    expect(state.subscriptions).toBe(1);
    expect(state.demands).toHaveLength(1);
    expect(state.cleanupInputs.at(-1)?.sessions).toBe(cleanupSessions);

    act(() => root.unmount());
    root = createRoot(dom.container);
    act(() => root.render(<LifecycleProbe isVSCode />));
    expect(state.globalRefreshes).toBe(0);
    expect(state.subscriptions).toBe(2);
    expect(state.unsubscriptions).toBe(1);
  });

  test('cancels a pending control-event refresh before a layout remount', async () => {
    act(() => root.render(<LifecycleProbe isVSCode={false} />));
    state.listener?.({ type: 'session-created', directory: '/created' });
    act(() => root.unmount());

    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(state.directoryRefreshes).toEqual([]);
    expect(state.unsubscriptions).toBe(1);
  });

  test('binds MainLayout ownership to real Store worktrees without duplicating lifecycle work across branches', () => {
    useProjectsStore.setState({
      projects: [{ id: 'project', path: '/project' }],
      activeProjectId: 'project',
    });
    useDirectoryStore.setState({ currentDirectory: '/project' });
    useSessionUIStore.setState({
      currentSessionDirectory: '/worktree',
      availableWorktreesByProject: new Map([['/project', [worktree]]]),
    });

    act(() => root.render(<LifecycleHarness isVSCode={false} branch="hidden" />));
    act(() => root.render(<LifecycleHarness isVSCode={false} branch="visible" />));
    act(() => root.render(<LifecycleHarness isVSCode={false} branch="expanded" />));

    expect(state.demands).toHaveLength(1);
    expect(state.demands[0]?.directories).toEqual(['/project', '/worktree']);
    expect(state.globalRefreshes).toBe(0);
    expect(state.subscriptions).toBe(1);
  });

  test('binds VS Code ownership to Store projects without worktrees and refreshes its first directories once', () => {
    useProjectsStore.setState({
      projects: [{ id: 'project', path: '/project' }],
      activeProjectId: 'project',
    });
    useDirectoryStore.setState({ currentDirectory: '/project' });
    useSessionUIStore.setState({
      currentSessionDirectory: '/project',
      availableWorktreesByProject: new Map([['/project', [worktree]]]),
    });

    act(() => root.render(<LifecycleHarness isVSCode branch="compact-sessions" />));
    act(() => root.render(<LifecycleHarness isVSCode branch="compact-chat" />));
    act(() => root.unmount());
    root = createRoot(dom.container);
    act(() => root.render(<LifecycleHarness isVSCode branch="compact-sessions" />));

    expect(state.demands.map((demand) => demand.directories)).toEqual([['/project'], ['/project']]);
    expect(state.directoryRefreshes).toEqual([['/project'], ['/project']]);
    expect(state.globalRefreshes).toBe(0);
    expect(state.subscriptions).toBe(2);
    expect(state.unsubscriptions).toBe(1);
  });

  test('does not rerender VS Code lifecycle ownership for worktree-map-only changes', () => {
    useProjectsStore.setState({
      projects: [{ id: 'project', path: '/project' }],
      activeProjectId: 'project',
    });
    useDirectoryStore.setState({ currentDirectory: '/project' });
    useSessionUIStore.setState({
      currentSessionDirectory: '/project',
      availableWorktreesByProject: new Map([['/project', [worktree]]]),
    });

    act(() => root.render(<LifecycleHarness isVSCode branch="compact-sessions" />));
    const cleanupInputCount = state.cleanupInputs.length;
    const demandCount = state.demands.length;
    const directoryRefreshCount = state.directoryRefreshes.length;
    const subscriptionCount = state.subscriptions;

    act(() => useSessionUIStore.setState({
      availableWorktreesByProject: new Map([['/project', [{ ...worktree, path: '/other-worktree' }]]]),
    }));

    expect(state.cleanupInputs).toHaveLength(cleanupInputCount);
    expect(state.demands).toHaveLength(demandCount);
    expect(state.directoryRefreshes).toHaveLength(directoryRefreshCount);
    expect(state.subscriptions).toBe(subscriptionCount);
  });
});
