import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionOwnershipIndex } from '../sessionOwnership';
import { prunePinnedSessionIds } from './pinnedSessionCleanup';

type RuntimeEndpointDetail = {
  runtimeKey: string;
  previousRuntimeKey: string;
};

type StateAction<T> = T | ((previous: T) => T);

const PROJECT_COLLAPSE_KEY = 'project-collapse';
const EXPANDED_KEY = 'expanded';
const EXPANDED_LEGACY_KEY = 'expanded-legacy';
const GROUP_ORDER_KEY = 'group-order';
const ACTIVE_SESSION_KEY = 'project-active-session';
const GROUP_COLLAPSE_KEY = 'group-collapse';

let runtimeKey = 'local';
let projects = [{ id: 'local-project', path: '/Users/local-user/projects/app' }];
let nextTimerId = 0;
const scheduledTimers = new Map<number, () => void>();
const runtimeListeners = new Set<(detail: RuntimeEndpointDetail) => void>();
const storageValues = new Map<string, string>();
const updateDesktopSettings = mock(async () => undefined);
const events = new EventTarget();
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const effectCleanups: Array<() => void> = [];
const deferredEffects: Array<() => void | (() => void)> = [];
let deferEffects = false;

const runtimeWindow = {
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  clearTimeout: () => undefined,
  setTimeout: (callback: () => void) => {
    nextTimerId += 1;
    scheduledTimers.set(nextTimerId, callback);
    return nextTimerId;
  },
};

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: runtimeWindow,
});

const runEffect = (effect: () => void | (() => void)): void => {
  const cleanup = effect();
  if (typeof cleanup === 'function') {
    effectCleanups.push(cleanup);
  }
};

const flushDeferredEffects = (): void => {
  while (deferredEffects.length > 0) {
    const effect = deferredEffects.shift();
    if (effect) {
      runEffect(effect);
    }
  }
};

const reactHooks = {
  useRef: <T,>(initial: T) => ({ current: initial }),
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    if (deferEffects) {
      deferredEffects.push(effect);
      return;
    }
    runEffect(effect);
  },
};

mock.module('react', () => ({
  default: reactHooks,
  ...reactHooks,
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings,
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => '',
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: (detail: RuntimeEndpointDetail) => void) => {
    runtimeListeners.add(listener);
    return () => runtimeListeners.delete(listener);
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({ projects }),
  },
}));

mock.module('../utils', () => ({
  getArchivedScopeKey: (projectPath: string) => `__archived__:${projectPath}`,
  normalizePath: (path: string | null | undefined) => path?.replace(/\\/g, '/') || null,
  resolveArchivedFolderName: () => 'archived',
}));

const { useSidebarPersistence } = await import('./useSidebarPersistence');
const { useSessionFolderCleanup } = await import('./useSessionFolderCleanup');
const { useArchivedAutoFolders } = await import('./useArchivedAutoFolders');

const makeSession = (id: string): Pick<Session, 'id'> => ({ id });

const scopedKey = (key: string, targetRuntimeKey = runtimeKey): string => (
  `${key}:${encodeURIComponent(targetRuntimeKey)}`
);

const safeStorage = {
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => storageValues.set(key, value),
  removeItem: (key: string) => storageValues.delete(key),
};

type PersistenceState = {
  expandedParents: Set<string>;
  collapsedProjects: Set<string>;
  groupOrderByProject: Map<string, string[]>;
  activeSessionByProject: Map<string, string>;
  collapsedGroups: Set<string>;
};

const applyStateAction = <T,>(current: T, next: StateAction<T>): T => (
  typeof next === 'function' ? (next as (previous: T) => T)(current) : next
);

const usePersistenceHarness = (initial: Partial<PersistenceState> = {}) => {
  const state: PersistenceState = {
    expandedParents: initial.expandedParents ?? new Set(),
    collapsedProjects: initial.collapsedProjects ?? new Set(),
    groupOrderByProject: initial.groupOrderByProject ?? new Map(),
    activeSessionByProject: initial.activeSessionByProject ?? new Map(),
    collapsedGroups: initial.collapsedGroups ?? new Set(),
  };

  const result = useSidebarPersistence({
    isVSCode: false,
    hasAuthoritativeGlobalSessions: false,
    safeStorage,
    keys: {
      sessionExpanded: EXPANDED_KEY,
      sessionExpandedLegacy: EXPANDED_LEGACY_KEY,
      projectCollapse: PROJECT_COLLAPSE_KEY,
      sessionPinned: 'pinned',
      groupOrder: GROUP_ORDER_KEY,
      projectActiveSession: ACTIVE_SESSION_KEY,
      groupCollapse: GROUP_COLLAPSE_KEY,
    },
    sessions: [],
    pinnedSessionIds: new Set<string>(),
    setPinnedSessionIds: () => undefined,
    groupOrderByProject: state.groupOrderByProject,
    setGroupOrderByProject: (next) => {
      state.groupOrderByProject = applyStateAction(state.groupOrderByProject, next);
    },
    activeSessionByProject: state.activeSessionByProject,
    setActiveSessionByProject: (next) => {
      state.activeSessionByProject = applyStateAction(state.activeSessionByProject, next);
    },
    collapsedGroups: state.collapsedGroups,
    setCollapsedGroups: (next) => {
      state.collapsedGroups = applyStateAction(state.collapsedGroups, next);
    },
    setExpandedParents: (next) => {
      state.expandedParents = applyStateAction(state.expandedParents, next);
    },
    setCollapsedProjects: (next) => {
      state.collapsedProjects = applyStateAction(state.collapsedProjects, next);
    },
  });

  return { state, ...result };
};

const emitRuntimeEndpointChanged = (nextRuntimeKey: string, previousRuntimeKey = runtimeKey): void => {
  runtimeKey = nextRuntimeKey;
  runtimeListeners.forEach((listener) => listener({ runtimeKey: nextRuntimeKey, previousRuntimeKey }));
};

const runTimer = (id: number): void => {
  const callback = scheduledTimers.get(id);
  if (callback) {
    callback();
  }
};

const createOwnership = (): SessionOwnershipIndex => {
  const owner = {
    projectId: 'project-a',
    projectRoot: '/workspace/project',
    scopeDirectory: '/workspace/project',
    kind: 'project' as const,
  };
  const archivedSession = { id: 'archived-a', directory: '/workspace/project/archive' } as Session;
  return {
    bySessionId: new Map([['session-a', owner]]),
    sessionsByProject: new Map(),
    archivedSessionsByProject: new Map([['project-a', [archivedSession]]]),
    sessionsByScope: new Map([['/workspace/project', new Set(['session-a'])]]),
    directoryResolutions: 1,
  };
};

describe('prunePinnedSessionIds', () => {
  test('keeps pinned ids that still exist in the authoritative session list', () => {
    const sessions = [makeSession('visible-session'), makeSession('hidden-session')];
    const pinnedSessionIds = new Set(['hidden-session', 'missing-session']);

    const next = prunePinnedSessionIds(sessions, pinnedSessionIds);

    expect([...next]).toEqual(['hidden-session']);
    expect(next).not.toBe(pinnedSessionIds);
  });

  test('returns the original set when nothing needs pruning', () => {
    const sessions = [makeSession('visible-session'), makeSession('hidden-session')];
    const pinnedSessionIds = new Set(['visible-session', 'hidden-session']);

    const next = prunePinnedSessionIds(sessions, pinnedSessionIds);

    expect(next).toBe(pinnedSessionIds);
  });
});

describe('sidebar runtime persistence', () => {
  beforeEach(() => {
    while (effectCleanups.length > 0) {
      effectCleanups.pop()?.();
    }
    deferredEffects.length = 0;
    deferEffects = false;
    runtimeKey = 'local';
    projects = [{ id: 'local-project', path: '/Users/local-user/projects/app' }];
    nextTimerId = 0;
    scheduledTimers.clear();
    storageValues.clear();
    updateDesktopSettings.mockClear();
  });

  afterAll(() => {
    while (effectCleanups.length > 0) {
      effectCleanups.pop()?.();
    }
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('keeps all sidebar metadata isolated when project and session IDs collide', () => {
    runtimeKey = 'runtime-a';
    const projectId = 'shared-project';
    storageValues.set(scopedKey(EXPANDED_KEY, 'runtime-a'), JSON.stringify(['project:active:session-a']));
    storageValues.set(scopedKey(PROJECT_COLLAPSE_KEY, 'runtime-a'), JSON.stringify([projectId]));
    storageValues.set(scopedKey(GROUP_ORDER_KEY, 'runtime-a'), JSON.stringify({ [projectId]: ['group-a'] }));
    storageValues.set(scopedKey(ACTIVE_SESSION_KEY, 'runtime-a'), JSON.stringify({ [projectId]: 'session-a' }));
    storageValues.set(scopedKey(GROUP_COLLAPSE_KEY, 'runtime-a'), JSON.stringify(['group-a']));
    storageValues.set(EXPANDED_KEY, JSON.stringify(['legacy-parent']));
    storageValues.set(PROJECT_COLLAPSE_KEY, JSON.stringify(['legacy-project']));

    storageValues.set(scopedKey(EXPANDED_KEY, 'runtime-b'), JSON.stringify(['project:active:session-b']));
    storageValues.set(scopedKey(PROJECT_COLLAPSE_KEY, 'runtime-b'), JSON.stringify([]));
    storageValues.set(scopedKey(GROUP_ORDER_KEY, 'runtime-b'), JSON.stringify({ [projectId]: ['group-b'] }));
    storageValues.set(scopedKey(ACTIVE_SESSION_KEY, 'runtime-b'), JSON.stringify({ [projectId]: 'session-b' }));
    storageValues.set(scopedKey(GROUP_COLLAPSE_KEY, 'runtime-b'), JSON.stringify(['group-b']));

    const { state } = usePersistenceHarness({
      expandedParents: new Set(['project:active:session-a']),
      collapsedProjects: new Set([projectId]),
      groupOrderByProject: new Map([[projectId, ['group-a']]]),
      activeSessionByProject: new Map([[projectId, 'session-a']]),
      collapsedGroups: new Set(['group-a']),
    });

    expect(state.collapsedProjects).toEqual(new Set([projectId]));
    emitRuntimeEndpointChanged('runtime-b', 'runtime-a');

    expect(state.expandedParents).toEqual(new Set(['project:active:session-b']));
    expect(state.collapsedProjects).toEqual(new Set());
    expect(state.groupOrderByProject).toEqual(new Map([[projectId, ['group-b']]]));
    expect(state.activeSessionByProject).toEqual(new Map([[projectId, 'session-b']]));
    expect(state.collapsedGroups).toEqual(new Set(['group-b']));
  });

  test('uses unscoped sidebar metadata only as a local migration fallback', () => {
    storageValues.set(EXPANDED_KEY, JSON.stringify(['project:active:local-session']));
    storageValues.set(PROJECT_COLLAPSE_KEY, JSON.stringify(['local-project']));
    storageValues.set(GROUP_ORDER_KEY, JSON.stringify({ 'local-project': ['local-group'] }));
    storageValues.set(ACTIVE_SESSION_KEY, JSON.stringify({ 'local-project': 'local-session' }));
    storageValues.set(GROUP_COLLAPSE_KEY, JSON.stringify(['local-group']));

    const { state } = usePersistenceHarness();

    expect(state.expandedParents).toEqual(new Set(['project:active:local-session']));
    expect(state.collapsedProjects).toEqual(new Set(['local-project']));
    expect(state.groupOrderByProject).toEqual(new Map([['local-project', ['local-group']]]));
    expect(state.activeSessionByProject).toEqual(new Map([['local-project', 'local-session']]));
    expect(state.collapsedGroups).toEqual(new Set(['local-group']));

    emitRuntimeEndpointChanged('remote-runtime', 'local');

    expect(state.expandedParents).toEqual(new Set());
    expect(state.collapsedProjects).toEqual(new Set());
    expect(state.groupOrderByProject).toEqual(new Map());
    expect(state.activeSessionByProject).toEqual(new Map());
    expect(state.collapsedGroups).toEqual(new Set());
  });

  test('applies authoritative project collapse metadata for the active runtime', () => {
    runtimeKey = 'remote-runtime';
    const { state } = usePersistenceHarness();

    runtimeWindow.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
      detail: {
        projects: [
          { id: 'remote-project', sidebarCollapsed: true },
          { id: 'expanded-project', sidebarCollapsed: false },
        ],
      },
    }));

    expect(state.collapsedProjects).toEqual(new Set(['remote-project']));
    expect(storageValues.get(scopedKey(PROJECT_COLLAPSE_KEY, 'remote-runtime'))).toBe(JSON.stringify(['remote-project']));
  });

  test('does not send a local collapsed-project update after switching to a remote runtime', () => {
    const { scheduleCollapsedProjectsPersist } = usePersistenceHarness();
    scheduleCollapsedProjectsPersist(new Set(['local-project']));

    runtimeKey = 'remote-runtime';
    runTimer(1);

    expect(updateDesktopSettings).not.toHaveBeenCalled();
  });

  test('rejects an old A callback after an A-to-B-to-A switch', () => {
    runtimeKey = 'runtime-a';
    projects = [{ id: 'shared-project', path: '/workspace/a' }];
    const { scheduleCollapsedProjectsPersist } = usePersistenceHarness();
    scheduleCollapsedProjectsPersist(new Set(['old-a']));

    emitRuntimeEndpointChanged('runtime-b', 'runtime-a');
    emitRuntimeEndpointChanged('runtime-a', 'runtime-b');
    scheduleCollapsedProjectsPersist(new Set(['new-a']));

    runTimer(1);
    expect(updateDesktopSettings).not.toHaveBeenCalled();

    runTimer(2);
    expect(updateDesktopSettings).toHaveBeenCalledWith({
      projects: [{
        id: 'shared-project',
        path: '/workspace/a',
        sidebarCollapsed: false,
      }],
    });
  });

  test('keeps collapsed-project persistence for updates scheduled on the active remote runtime', () => {
    runtimeKey = 'remote-runtime';
    projects = [{ id: 'remote-project', path: '/home/remote-user/project' }];
    const { scheduleCollapsedProjectsPersist } = usePersistenceHarness();
    scheduleCollapsedProjectsPersist(new Set(['remote-project']));

    runTimer(1);

    expect(updateDesktopSettings).toHaveBeenCalledWith({
      projects: [{
        id: 'remote-project',
        path: '/home/remote-user/project',
        sidebarCollapsed: true,
      }],
    });
  });

  test('rejects stale folder cleanup and archived-folder effects after an A-to-B-to-A switch', () => {
    runtimeKey = 'runtime-a';
    const ownership = createOwnership();
    const cleanupSessions = mock(() => undefined);
    const createFolder = mock(() => ({ id: 'folder-a', name: 'archived', sessionIds: [] }));
    const addSessionToFolder = mock(() => undefined);
    deferEffects = true;

    useSessionFolderCleanup({
      isSessionsLoading: false,
      hasAuthoritativeGlobalSessions: true,
      isWorktreeTopologyLoading: false,
      normalizedProjects: [{ id: 'project-a', normalizedPath: '/workspace/project' }],
      ownership,
      availableWorktreesByProject: new Map(),
      unresolvedWorktreeProjectPaths: new Set(),
      cleanupSessions,
    });
    useArchivedAutoFolders({
      normalizedProjects: [{ id: 'project-a', normalizedPath: '/workspace/project' }],
      ownership,
      isSessionsLoading: false,
      hasAuthoritativeGlobalSessions: true,
      isWorktreeTopologyLoading: false,
      unresolvedWorktreeProjectPaths: new Set(),
      foldersMap: {},
      createFolder,
      addSessionToFolder,
      cleanupSessions,
    });

    emitRuntimeEndpointChanged('runtime-b', 'runtime-a');
    emitRuntimeEndpointChanged('runtime-a', 'runtime-b');
    deferEffects = false;
    flushDeferredEffects();

    expect(cleanupSessions).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
    expect(addSessionToFolder).not.toHaveBeenCalled();

    useSessionFolderCleanup({
      isSessionsLoading: false,
      hasAuthoritativeGlobalSessions: true,
      isWorktreeTopologyLoading: false,
      normalizedProjects: [{ id: 'project-a', normalizedPath: '/workspace/project' }],
      ownership,
      availableWorktreesByProject: new Map(),
      unresolvedWorktreeProjectPaths: new Set(),
      cleanupSessions,
    });
    useArchivedAutoFolders({
      normalizedProjects: [{ id: 'project-a', normalizedPath: '/workspace/project' }],
      ownership,
      isSessionsLoading: false,
      hasAuthoritativeGlobalSessions: true,
      isWorktreeTopologyLoading: false,
      unresolvedWorktreeProjectPaths: new Set(),
      foldersMap: {},
      createFolder,
      addSessionToFolder,
      cleanupSessions,
    });

    expect(cleanupSessions).toHaveBeenCalled();
    expect(createFolder).toHaveBeenCalledWith('__archived__:/workspace/project', 'archived');
    expect(addSessionToFolder).toHaveBeenCalledWith('__archived__:/workspace/project', 'folder-a', 'archived-a');
  });
});
