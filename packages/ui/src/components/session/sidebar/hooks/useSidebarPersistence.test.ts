import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { prunePinnedSessionIds } from './pinnedSessionCleanup';

const makeSession = (id: string): Pick<Session, 'id'> => ({ id });

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
};

type HookEffect = () => void | (() => void);

const hookRecord: HookRecord = { values: [], deps: [] };
let hookIndex = 0;
let pendingEffects: HookEffect[] = [];

const resetHarness = () => {
  hookRecord.values = [];
  hookRecord.deps = [];
  hookIndex = 0;
  pendingEffects = [];
};

const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const useRef = <T,>(initialValue: T): { current: T } => {
  const index = hookIndex++;
  if (hookRecord.values[index] === undefined) {
    hookRecord.values[index] = { current: initialValue };
  }
  return hookRecord.values[index] as { current: T };
};

const useCallback = <T extends (...args: never[]) => unknown>(callback: T, deps?: unknown[]): T => {
  const index = hookIndex++;
  const previousDeps = hookRecord.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    hookRecord.values[index] = callback;
    hookRecord.deps[index] = deps;
  }
  return hookRecord.values[index] as T;
};

const useEffect = (effect: HookEffect, deps?: unknown[]): void => {
  const index = hookIndex++;
  const previousDeps = hookRecord.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    hookRecord.deps[index] = deps;
    pendingEffects.push(effect);
  }
};

const ReactMock = {
  useCallback,
  useEffect,
  useRef,
};

mock.module('react', () => ({
  __esModule: true,
  default: ReactMock,
  ...ReactMock,
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({ projects: [] }),
  },
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: () => Promise.resolve(),
}));

const { useSidebarPersistence } = await import('./useSidebarPersistence');

type SidebarPersistenceArgs = Parameters<typeof useSidebarPersistence>[0];

const flushEffects = async () => {
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      effect();
    }
    await Promise.resolve();
  }
};

const renderHook = (args: SidebarPersistenceArgs) => {
  hookIndex = 0;
  const result = useSidebarPersistence(args);
  return result;
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

describe('useSidebarPersistence', () => {
  test('keeps hidden-but-valid pins and clears stale pins when the authoritative list becomes empty', async () => {
    resetHarness();

    let pinnedSessionIds = new Set(['hidden-session', 'missing-session']);
    const setPinnedSessionIds = (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      pinnedSessionIds = typeof next === 'function' ? next(pinnedSessionIds) : next;
    };

    const baseArgs: SidebarPersistenceArgs = {
      isVSCode: false,
      hasLoadedGlobalSessions: true,
      safeStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
      keys: {
        sessionExpanded: 'expanded',
        sessionExpandedLegacy: 'expanded-legacy',
        projectCollapse: 'project-collapse',
        sessionPinned: 'session-pinned',
        groupOrder: 'group-order',
        projectActiveSession: 'project-active-session',
        groupCollapse: 'group-collapse',
      },
      sessions: [makeSession('hidden-session'), makeSession('visible-session')] as Session[],
      pinnedSessionIds,
      setPinnedSessionIds,
      groupOrderByProject: new Map(),
      activeSessionByProject: new Map(),
      collapsedGroups: new Set(),
      setExpandedParents: () => undefined,
      setCollapsedProjects: () => undefined,
    };

    renderHook(baseArgs);
    await flushEffects();

    expect([...pinnedSessionIds]).toEqual(['hidden-session']);

    renderHook({
      ...baseArgs,
      sessions: [] as Session[],
      pinnedSessionIds,
    });
    await flushEffects();

    expect([...pinnedSessionIds]).toEqual([]);
  });
});
