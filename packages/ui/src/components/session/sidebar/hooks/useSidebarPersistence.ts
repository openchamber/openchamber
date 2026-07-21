import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { readRuntimeScopedStorage, writeRuntimeScopedStorage } from '@/stores/utils/runtimeScopedStorage';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { prunePinnedSessionIds } from './pinnedSessionCleanup';

type SafeStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
};

type Keys = {
  sessionExpanded: string;
  // v1 key, still on disk for users upgrading from pre-per-context expansion.
  // When present, its bare-session-id entries are fanned out to all four
  // (project|recent) × (active|archived) context combinations and rewritten
  // under `sessionExpanded`. After migration the v1 key is removed.
  sessionExpandedLegacy: string;
  projectCollapse: string;
  sessionPinned: string;
  groupOrder: string;
  projectActiveSession: string;
  groupCollapse: string;
};

type SidebarRuntimeContext = {
  runtimeKey: string;
  generation: number;
};

const LEGACY_EXPANSION_CONTEXT_PREFIXES = [
  'project:active:',
  'project:archived:',
  'recent:active:',
  'recent:archived:',
];

const parseStringSet = (raw: string | null): Set<string> => {
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
};

export const readSidebarStringSet = (
  safeStorage: SafeStorageLike,
  key: string,
  runtimeKey = getRuntimeKey(),
): Set<string> => {
  return parseStringSet(readRuntimeScopedStorage(safeStorage, key, runtimeKey));
};

export const readSidebarGroupOrder = (
  safeStorage: SafeStorageLike,
  key: string,
  runtimeKey = getRuntimeKey(),
): Map<string, string[]> => {
  try {
    const raw = readRuntimeScopedStorage(safeStorage, key, runtimeKey);
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map();
    }
    const next = new Map<string, string[]>();
    Object.entries(parsed).forEach(([projectId, order]) => {
      if (Array.isArray(order)) {
        next.set(projectId, order.filter((item): item is string => typeof item === 'string'));
      }
    });
    return next;
  } catch {
    return new Map();
  }
};

export const readSidebarActiveSessions = (
  safeStorage: SafeStorageLike,
  key: string,
  runtimeKey = getRuntimeKey(),
): Map<string, string> => {
  try {
    const raw = readRuntimeScopedStorage(safeStorage, key, runtimeKey);
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map();
    }
    const next = new Map<string, string>();
    Object.entries(parsed).forEach(([projectId, sessionId]) => {
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        next.set(projectId, sessionId);
      }
    });
    return next;
  } catch {
    return new Map();
  }
};

const readExpandedParents = (
  safeStorage: SafeStorageLike,
  sessionExpandedKey: string,
  sessionExpandedLegacyKey: string,
  runtimeKey: string,
): Set<string> => {
  const storedParents = readRuntimeScopedStorage(safeStorage, sessionExpandedKey, runtimeKey);
  if (storedParents !== null) {
    return parseStringSet(storedParents);
  }

  const legacyRaw = readRuntimeScopedStorage(safeStorage, sessionExpandedLegacyKey, runtimeKey);
  if (legacyRaw === null) {
    return new Set();
  }

  const legacyParents = parseStringSet(legacyRaw);
  const migrated = new Set<string>();
  legacyParents.forEach((item) => {
    LEGACY_EXPANSION_CONTEXT_PREFIXES.forEach((prefix) => migrated.add(`${prefix}${item}`));
  });
  if (migrated.size > 0) {
    try {
      writeRuntimeScopedStorage(safeStorage, sessionExpandedKey, JSON.stringify(Array.from(migrated)), runtimeKey);
    } catch {
      // ignored
    }
  }
  if (runtimeKey === 'local') {
    try {
      safeStorage.removeItem?.(sessionExpandedLegacyKey);
    } catch {
      // ignored
    }
  }
  return migrated;
};

type Args = {
  isVSCode: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  safeStorage: SafeStorageLike;
  keys: Keys;
  sessions: Session[];
  pinnedSessionIds: Set<string>;
  setPinnedSessionIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  groupOrderByProject: Map<string, string[]>;
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  activeSessionByProject: Map<string, string>;
  setActiveSessionByProject: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  collapsedGroups: Set<string>;
  setCollapsedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  setExpandedParents: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCollapsedProjects: React.Dispatch<React.SetStateAction<Set<string>>>;
};

export const useSidebarPersistence = (args: Args) => {
  const {
    isVSCode,
    hasAuthoritativeGlobalSessions,
    safeStorage,
    keys,
    sessions,
    setPinnedSessionIds,
    groupOrderByProject,
    setGroupOrderByProject,
    activeSessionByProject,
    setActiveSessionByProject,
    collapsedGroups,
    setCollapsedGroups,
    setExpandedParents,
    setCollapsedProjects,
  } = args;

  const persistCollapsedProjectsTimer = React.useRef<number | null>(null);
  const pendingCollapsedProjects = React.useRef<{
    collapsed: Set<string>;
    runtimeContext: SidebarRuntimeContext;
  } | null>(null);
  const runtimeGeneration = React.useRef(0);
  const captureRuntimeContext = React.useCallback((): SidebarRuntimeContext => ({
    runtimeKey: getRuntimeKey(),
    generation: runtimeGeneration.current,
  }), []);
  const isRuntimeContextCurrent = React.useCallback((context: SidebarRuntimeContext): boolean => (
    context.generation === runtimeGeneration.current && context.runtimeKey === getRuntimeKey()
  ), []);
  const runtimeContextAtRender = captureRuntimeContext();
  const runtimeKeyAtRender = runtimeContextAtRender.runtimeKey;
  const runtimeGenerationAtRender = runtimeContextAtRender.generation;

  const reloadRuntimeState = React.useCallback((runtimeContext: SidebarRuntimeContext): void => {
    if (!isRuntimeContextCurrent(runtimeContext)) {
      return;
    }

    setExpandedParents(readExpandedParents(
      safeStorage,
      keys.sessionExpanded,
      keys.sessionExpandedLegacy,
      runtimeContext.runtimeKey,
    ));
    setCollapsedProjects(readSidebarStringSet(safeStorage, keys.projectCollapse, runtimeContext.runtimeKey));
    setGroupOrderByProject(readSidebarGroupOrder(safeStorage, keys.groupOrder, runtimeContext.runtimeKey));
    setActiveSessionByProject(readSidebarActiveSessions(safeStorage, keys.projectActiveSession, runtimeContext.runtimeKey));
    setCollapsedGroups(readSidebarStringSet(safeStorage, keys.groupCollapse, runtimeContext.runtimeKey));
  }, [
    isRuntimeContextCurrent,
    keys.groupCollapse,
    keys.groupOrder,
    keys.projectActiveSession,
    keys.projectCollapse,
    keys.sessionExpanded,
    keys.sessionExpandedLegacy,
    safeStorage,
    setActiveSessionByProject,
    setCollapsedGroups,
    setCollapsedProjects,
    setExpandedParents,
    setGroupOrderByProject,
  ]);

  const flushCollapsedProjectsPersist = React.useCallback((expectedRuntimeContext: SidebarRuntimeContext) => {
    if (isVSCode) {
      return;
    }
    const pending = pendingCollapsedProjects.current;
    if (
      !pending
      || pending.runtimeContext.runtimeKey !== expectedRuntimeContext.runtimeKey
      || pending.runtimeContext.generation !== expectedRuntimeContext.generation
      || !isRuntimeContextCurrent(pending.runtimeContext)
    ) {
      return;
    }
    pendingCollapsedProjects.current = null;
    persistCollapsedProjectsTimer.current = null;

    const { collapsed } = pending;
    const { projects } = useProjectsStore.getState();
    const updatedProjects = projects.map((project) => ({
      ...project,
      sidebarCollapsed: collapsed.has(project.id),
    }));
    void updateDesktopSettings({ projects: updatedProjects }).catch(() => {});
  }, [isRuntimeContextCurrent, isVSCode]);

  const scheduleCollapsedProjectsPersist = React.useCallback((collapsed: Set<string>) => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    const runtimeContext = captureRuntimeContext();
    pendingCollapsedProjects.current = {
      collapsed: new Set(collapsed),
      runtimeContext,
    };
    if (persistCollapsedProjectsTimer.current !== null) {
      window.clearTimeout(persistCollapsedProjectsTimer.current);
    }
    persistCollapsedProjectsTimer.current = window.setTimeout(() => {
      flushCollapsedProjectsPersist(runtimeContext);
    }, 700);
  }, [captureRuntimeContext, isVSCode, flushCollapsedProjectsPersist]);

  React.useEffect(() => {
    const initialContext = captureRuntimeContext();
    reloadRuntimeState(initialContext);

    return subscribeRuntimeEndpointChanged((detail) => {
      if (detail.runtimeKey === detail.previousRuntimeKey) {
        return;
      }
      runtimeGeneration.current += 1;
      if (typeof window !== 'undefined' && persistCollapsedProjectsTimer.current !== null) {
        window.clearTimeout(persistCollapsedProjectsTimer.current);
      }
      persistCollapsedProjectsTimer.current = null;
      pendingCollapsedProjects.current = null;
      reloadRuntimeState(captureRuntimeContext());
    });
  }, [captureRuntimeContext, reloadRuntimeState]);

  React.useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && persistCollapsedProjectsTimer.current !== null) {
        window.clearTimeout(persistCollapsedProjectsTimer.current);
      }
      persistCollapsedProjectsTimer.current = null;
      pendingCollapsedProjects.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onSettingsSynced = (event: Event) => {
      const settings = (event as CustomEvent<{ projects?: unknown }>).detail;
      if (!settings || !Array.isArray(settings.projects)) {
        return;
      }
      const runtimeContext = captureRuntimeContext();
      if (!isRuntimeContextCurrent(runtimeContext)) {
        return;
      }
      const collapsed = new Set(
        settings.projects
          .filter((project): project is { id: string; sidebarCollapsed?: boolean } => (
            Boolean(project)
            && typeof project === 'object'
            && typeof (project as { id?: unknown }).id === 'string'
          ))
          .filter((project) => project.sidebarCollapsed === true)
          .map((project) => project.id),
      );
      setCollapsedProjects(collapsed);
      try {
        writeRuntimeScopedStorage(
          safeStorage,
          keys.projectCollapse,
          JSON.stringify(Array.from(collapsed)),
          runtimeContext.runtimeKey,
        );
      } catch {
        // ignored
      }
    };

    window.addEventListener('openchamber:settings-synced', onSettingsSynced);
    return () => window.removeEventListener('openchamber:settings-synced', onSettingsSynced);
  }, [captureRuntimeContext, isRuntimeContextCurrent, keys.projectCollapse, safeStorage, setCollapsedProjects]);

  React.useEffect(() => {
    if (!hasAuthoritativeGlobalSessions) {
      return;
    }

    setPinnedSessionIds((prev) => {
      return prunePinnedSessionIds(sessions, prev);
    });
  }, [hasAuthoritativeGlobalSessions, sessions, setPinnedSessionIds]);

  React.useEffect(() => {
    if (!isRuntimeContextCurrent({
      runtimeKey: runtimeKeyAtRender,
      generation: runtimeGenerationAtRender,
    })) {
      return;
    }
    try {
      const serialized = Object.fromEntries(groupOrderByProject.entries());
      writeRuntimeScopedStorage(safeStorage, keys.groupOrder, JSON.stringify(serialized), runtimeKeyAtRender);
    } catch {
      // ignored
    }
  }, [
    groupOrderByProject,
    isRuntimeContextCurrent,
    keys.groupOrder,
    runtimeGenerationAtRender,
    runtimeKeyAtRender,
    safeStorage,
  ]);

  React.useEffect(() => {
    if (!isRuntimeContextCurrent({
      runtimeKey: runtimeKeyAtRender,
      generation: runtimeGenerationAtRender,
    })) {
      return;
    }
    try {
      const serialized = Object.fromEntries(activeSessionByProject.entries());
      writeRuntimeScopedStorage(safeStorage, keys.projectActiveSession, JSON.stringify(serialized), runtimeKeyAtRender);
    } catch {
      // ignored
    }
  }, [
    activeSessionByProject,
    isRuntimeContextCurrent,
    keys.projectActiveSession,
    runtimeGenerationAtRender,
    runtimeKeyAtRender,
    safeStorage,
  ]);

  React.useEffect(() => {
    if (!isRuntimeContextCurrent({
      runtimeKey: runtimeKeyAtRender,
      generation: runtimeGenerationAtRender,
    })) {
      return;
    }
    try {
      writeRuntimeScopedStorage(
        safeStorage,
        keys.groupCollapse,
        JSON.stringify(Array.from(collapsedGroups)),
        runtimeKeyAtRender,
      );
    } catch {
      // ignored
    }
  }, [
    collapsedGroups,
    isRuntimeContextCurrent,
    keys.groupCollapse,
    runtimeGenerationAtRender,
    runtimeKeyAtRender,
    safeStorage,
  ]);

  return { scheduleCollapsedProjectsPersist };
};
