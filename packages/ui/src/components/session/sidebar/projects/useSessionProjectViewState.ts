import React from 'react';
import { updateDesktopSettings } from '@/lib/persistence';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { z } from 'zod';
import { useGroupOrdering } from './useGroupOrdering';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_ORDER_STORAGE_KEY = 'oc.sessions.groupOrder';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';

type Project = { id: string };

type SessionProjectViewStateArgs = {
  isVSCode: boolean;
  projects: readonly Project[];
};

const parseStringSet = (raw: string | null): Set<string> => {
  if (!raw) return new Set();
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return new Set(parsed.success ? parsed.data : []);
  } catch {
    return new Set();
  }
};

const parseGroupOrder = (raw: string | null): Map<string, string[]> => {
  if (!raw) return new Map();
  try {
    const parsed = z.record(z.string(), z.array(z.string())).safeParse(JSON.parse(raw));
    if (!parsed.success) return new Map();
    const next = new Map<string, string[]>();
    for (const [projectId, order] of Object.entries(parsed.data)) {
      next.set(projectId, order);
    }
    return next;
  } catch {
    return new Map();
  }
};

export const useSessionProjectViewState = ({
  isVSCode,
  projects,
}: SessionProjectViewStateArgs) => {
  const safeStorage = React.useMemo(() => getDeferredSafeStorage(), []);
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(() => (
    parseStringSet(safeStorage.getItem(PROJECT_COLLAPSE_STORAGE_KEY))
  ));
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => (
    parseStringSet(safeStorage.getItem(GROUP_COLLAPSE_STORAGE_KEY))
  ));
  const [groupOrderByProject, setGroupOrderByProject] = React.useState<Map<string, string[]>>(() => (
    parseGroupOrder(safeStorage.getItem(GROUP_ORDER_STORAGE_KEY))
  ));
  const ignoreIntersectionUntil = React.useRef<number>(0);
  const groupCollapseDirty = React.useRef(false);
  const groupOrderDirty = React.useRef(false);
  const persistCollapsedProjectsTimer = React.useRef<number | null>(null);
  const pendingCollapsedProjects = React.useRef<Set<string> | null>(null);

  const flushCollapsedProjectsPersist = React.useCallback(() => {
    if (isVSCode) return;
    const collapsed = pendingCollapsedProjects.current;
    pendingCollapsedProjects.current = null;
    persistCollapsedProjectsTimer.current = null;
    if (!collapsed) return;

    const { projects: storedProjects } = useProjectsStore.getState();
    const updatedProjects = storedProjects.map((project) => ({
      ...project,
      sidebarCollapsed: collapsed.has(project.id),
    }));
    void updateDesktopSettings({ projects: updatedProjects }).catch(() => {});
  }, [isVSCode]);

  const scheduleCollapsedProjectsPersist = React.useCallback((collapsed: Set<string>) => {
    if (!globalThis.window || isVSCode) return;
    pendingCollapsedProjects.current = collapsed;
    if (persistCollapsedProjectsTimer.current !== null) {
      window.clearTimeout(persistCollapsedProjectsTimer.current);
    }
    persistCollapsedProjectsTimer.current = window.setTimeout(() => {
      flushCollapsedProjectsPersist();
    }, 700);
  }, [flushCollapsedProjectsPersist, isVSCode]);

  React.useEffect(() => {
    return () => {
      if (globalThis.window && persistCollapsedProjectsTimer.current !== null) {
        window.clearTimeout(persistCollapsedProjectsTimer.current);
      }
      persistCollapsedProjectsTimer.current = null;
      pendingCollapsedProjects.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (!groupOrderDirty.current) return;
    try {
      safeStorage.setItem(GROUP_ORDER_STORAGE_KEY, JSON.stringify(Object.fromEntries(groupOrderByProject.entries())));
    } catch {
      // ignored
    }
  }, [groupOrderByProject, safeStorage]);

  React.useEffect(() => {
    if (!groupCollapseDirty.current) return;
    try {
      safeStorage.setItem(GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsedGroups)));
    } catch {
      // ignored
    }
  }, [collapsedGroups, safeStorage]);

  const collapseAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    groupCollapseDirty.current = true;
    setCollapsedGroups(new Set());
    setCollapsedProjects(() => {
      const allIds = new Set(projects.map((project) => project.id));
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(allIds)));
      } catch {
        // ignored
      }
      scheduleCollapsedProjectsPersist(allIds);
      return allIds;
    });
  }, [projects, safeStorage, scheduleCollapsedProjectsPersist]);

  const expandAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    groupCollapseDirty.current = true;
    setCollapsedGroups(new Set());
    setCollapsedProjects(() => {
      const empty = new Set<string>();
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify([]));
      } catch {
        // ignored
      }
      scheduleCollapsedProjectsPersist(empty);
      return empty;
    });
  }, [safeStorage, scheduleCollapsedProjectsPersist]);

  const toggleProject = React.useCallback((projectId: string) => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // ignored
      }
      scheduleCollapsedProjectsPersist(next);
      return next;
    });
  }, [safeStorage, scheduleCollapsedProjectsPersist]);

  const toggleGroup = React.useCallback((key: string) => {
    groupCollapseDirty.current = true;
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const updateGroupOrderByProject = React.useCallback<React.Dispatch<React.SetStateAction<Map<string, string[]>>>>((update) => {
    groupOrderDirty.current = true;
    setGroupOrderByProject(update);
  }, []);

  const { getOrderedGroups } = useGroupOrdering(groupOrderByProject);
  const state = React.useMemo(() => ({
    collapsedProjects,
    collapsedGroups,
    groupOrderByProject,
  }), [collapsedGroups, collapsedProjects, groupOrderByProject]);
  const actions = React.useMemo(() => ({
    setCollapsedProjects,
    toggleProject,
    collapseAllProjects,
    expandAllProjects,
    scheduleCollapsedProjectsPersist,
    setCollapsedGroups,
    toggleGroup,
    setGroupOrderByProject: updateGroupOrderByProject,
    getOrderedGroups,
  }), [collapseAllProjects, expandAllProjects, getOrderedGroups, scheduleCollapsedProjectsPersist, toggleGroup, toggleProject, updateGroupOrderByProject]);

  return { state, actions };
};
