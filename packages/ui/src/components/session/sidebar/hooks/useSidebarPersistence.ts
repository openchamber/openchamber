import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { updateDesktopSettings } from '@/lib/persistence';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { prunePinnedSessionIds } from './pinnedSessionCleanup';
import { getRuntimeKey } from '@/lib/runtime-switch';

type SafeStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
};

type Keys = {
  sessionExpanded: string;
  // Optional legacy key for callers whose old expansion state is safe to migrate.
  sessionExpandedLegacy?: string;
  projectCollapse: string;
  sessionPinned: string;
  groupOrder: string;
  groupCollapse: string;
};

const LEGACY_EXPANSION_CONTEXT_PREFIXES = [
  'project:active:',
  'project:archived:',
  'recent:active:',
  'recent:archived:',
];

type Args = {
  isVSCode: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  safeStorage: SafeStorageLike;
  keys: Keys;
  sessions: Session[];
  pinnedSessionIds: Set<string>;
  setPinnedSessionIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  groupOrderByProject: Map<string, string[]>;
  collapsedGroups: Set<string>;
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
    collapsedGroups,
    setExpandedParents,
    setCollapsedProjects,
  } = args;

  const persistCollapsedProjectsTimer = React.useRef<number | null>(null);
  const pendingCollapsedProjects = React.useRef<Set<string> | null>(null);

  const flushCollapsedProjectsPersist = React.useCallback(() => {
    if (isVSCode) {
      return;
    }
    const collapsed = pendingCollapsedProjects.current;
    pendingCollapsedProjects.current = null;
    persistCollapsedProjectsTimer.current = null;
    if (!collapsed) {
      return;
    }

    const { projects } = useProjectsStore.getState();
    const updatedProjects = projects.map((project) => ({
      ...project,
      sidebarCollapsed: collapsed.has(project.id),
    }));
    void updateDesktopSettings({ projects: updatedProjects }).catch(() => {});
  }, [isVSCode]);

  const scheduleCollapsedProjectsPersist = React.useCallback((collapsed: Set<string>) => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    pendingCollapsedProjects.current = collapsed;
    if (persistCollapsedProjectsTimer.current !== null) {
      window.clearTimeout(persistCollapsedProjectsTimer.current);
    }
    persistCollapsedProjectsTimer.current = window.setTimeout(() => {
      flushCollapsedProjectsPersist();
    }, 700);
  }, [isVSCode, flushCollapsedProjectsPersist]);

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
    try {
      const storedParents = safeStorage.getItem(keys.sessionExpanded);
      if (storedParents) {
        const parsed = JSON.parse(storedParents);
        if (Array.isArray(parsed)) {
          setExpandedParents(new Set(parsed.filter((item) => typeof item === 'string')));
        }
      } else {
        // No v2 data — migrate from v1 (bare session ids) if present.
        const legacyRaw = keys.sessionExpandedLegacy
          ? safeStorage.getItem(keys.sessionExpandedLegacy)
          : null;
        if (legacyRaw) {
          try {
            const parsedLegacy = JSON.parse(legacyRaw);
            if (Array.isArray(parsedLegacy)) {
              const migrated = new Set<string>();
              parsedLegacy.forEach((item) => {
                if (typeof item !== 'string' || item.length === 0) return;
                LEGACY_EXPANSION_CONTEXT_PREFIXES.forEach((prefix) => migrated.add(`${prefix}${item}`));
              });
              if (migrated.size > 0) {
                setExpandedParents(migrated);
                try { safeStorage.setItem(keys.sessionExpanded, JSON.stringify(Array.from(migrated))); } catch { /* ignored */ }
              }
            }
          } catch {
            // legacy data was malformed; ignore and let it expire
          }
          try {
            if (keys.sessionExpandedLegacy) safeStorage.removeItem?.(keys.sessionExpandedLegacy);
          } catch { /* ignored */ }
        }
      }
      const storedProjects = safeStorage.getItem(keys.projectCollapse);
      if (storedProjects) {
        const parsed = JSON.parse(storedProjects);
        if (Array.isArray(parsed)) {
          setCollapsedProjects(new Set(parsed.filter((item) => typeof item === 'string')));
        }
      }
    } catch {
      // ignored
    }
  }, [keys.projectCollapse, keys.sessionExpanded, keys.sessionExpandedLegacy, safeStorage, setCollapsedProjects, setExpandedParents]);

  React.useEffect(() => {
    if (!hasAuthoritativeGlobalSessions) {
      return;
    }

    setPinnedSessionIds((prev) => prunePinnedSessionIds(getRuntimeKey(), sessions, prev));
  }, [hasAuthoritativeGlobalSessions, sessions, setPinnedSessionIds]);

  React.useEffect(() => {
    try {
      const serialized = Object.fromEntries(groupOrderByProject.entries());
      safeStorage.setItem(keys.groupOrder, JSON.stringify(serialized));
    } catch {
      // ignored
    }
  }, [groupOrderByProject, keys.groupOrder, safeStorage]);

  React.useEffect(() => {
    try {
      safeStorage.setItem(keys.groupCollapse, JSON.stringify(Array.from(collapsedGroups)));
    } catch {
      // ignored
    }
  }, [collapsedGroups, keys.groupCollapse, safeStorage]);

  return { scheduleCollapsedProjectsPersist };
};
