import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { updateDesktopSettings } from '@/lib/persistence';
import { useProjectsStore } from '@/stores/useProjectsStore';

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

const LEGACY_EXPANSION_CONTEXT_PREFIXES = [
  'project:active:',
  'project:archived:',
  'recent:active:',
  'recent:archived:',
];

type Args = {
  isVSCode: boolean;
  hasLoadedGlobalSessions: boolean;
  safeStorage: SafeStorageLike;
  keys: Keys;
  sessions: Session[];
  pinnedSessionIds: Set<string>;
  setPinnedSessionIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  groupOrderByProject: Map<string, string[]>;
  activeSessionByProject: Map<string, string>;
  collapsedGroups: Set<string>;
  setExpandedParents: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCollapsedProjects: React.Dispatch<React.SetStateAction<Set<string>>>;
};

export const useSidebarPersistence = (args: Args) => {
  const {
    isVSCode,
    hasLoadedGlobalSessions,
    safeStorage,
    keys,
    sessions,
    setPinnedSessionIds,
    groupOrderByProject,
    activeSessionByProject,
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
        const legacyRaw = safeStorage.getItem(keys.sessionExpandedLegacy);
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
          try { safeStorage.removeItem?.(keys.sessionExpandedLegacy); } catch { /* ignored */ }
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
    if (!hasLoadedGlobalSessions) {
      return;
    }

    const existingSessionIds = new Set(sessions.map((session) => session.id));
    setPinnedSessionIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (existingSessionIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [hasLoadedGlobalSessions, sessions, setPinnedSessionIds]);

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
      const serialized = Object.fromEntries(activeSessionByProject.entries());
      safeStorage.setItem(keys.projectActiveSession, JSON.stringify(serialized));
    } catch {
      // ignored
    }
  }, [activeSessionByProject, keys.projectActiveSession, safeStorage]);

  React.useEffect(() => {
    try {
      safeStorage.setItem(keys.groupCollapse, JSON.stringify(Array.from(collapsedGroups)));
    } catch {
      // ignored
    }
  }, [collapsedGroups, keys.groupCollapse, safeStorage]);

  return { scheduleCollapsedProjectsPersist };
};
