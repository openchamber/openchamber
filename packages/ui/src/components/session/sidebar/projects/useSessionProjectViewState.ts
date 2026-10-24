import React from 'react';
import { updateDesktopSettings } from '@/lib/persistence';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { z } from 'zod';
import { SIDEBAR_ACTIVITY_KEYS } from '../sessionSidebarRowModel';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const ACTIVITY_COLLAPSE_STORAGE_KEY = 'oc.sessions.activityCollapse';
const WORK_EXPAND_STORAGE_KEY = 'oc.sessions.workExpand';

/**
 * Worktree works open the other way round from groups: a work is a row of its
 * own, so it starts folded. `expandedByDefault` is what Expand all / Collapse
 * all last set; `toggled` lists the works the user flipped since.
 */
type WorkExpansion = { expandedByDefault: boolean; toggled: ReadonlySet<string> };

const workExpansionSchema = z.object({ expandedByDefault: z.boolean(), toggled: z.array(z.string()) });

const parseWorkExpansion = (raw: string | null): WorkExpansion => {
  try {
    const parsed = raw ? workExpansionSchema.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success) return { expandedByDefault: parsed.data.expandedByDefault, toggled: new Set(parsed.data.toggled) };
  } catch {
    // A broken record starts folded.
  }
  return { expandedByDefault: false, toggled: new Set() };
};

/** Whether the worktree work under `key` is open. */
export const isWorkExpanded = (expansion: WorkExpansion, key: string): boolean => (
  expansion.expandedByDefault !== expansion.toggled.has(key)
);

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
  const [collapsedActivities, setCollapsedActivities] = React.useState<Set<string>>(() => (
    parseStringSet(safeStorage.getItem(ACTIVITY_COLLAPSE_STORAGE_KEY))
  ));
  const [workExpansion, setWorkExpansion] = React.useState<WorkExpansion>(() => (
    parseWorkExpansion(safeStorage.getItem(WORK_EXPAND_STORAGE_KEY))
  ));
  const workExpansionDirty = React.useRef(false);
  const ignoreIntersectionUntil = React.useRef<number>(0);
  const groupCollapseDirty = React.useRef(false);
  const activityCollapseDirty = React.useRef(false);
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
    if (!groupCollapseDirty.current) return;
    try {
      safeStorage.setItem(GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsedGroups)));
    } catch {
      // ignored
    }
  }, [collapsedGroups, safeStorage]);

  React.useEffect(() => {
    if (!workExpansionDirty.current) return;
    try {
      safeStorage.setItem(WORK_EXPAND_STORAGE_KEY, JSON.stringify({ expandedByDefault: workExpansion.expandedByDefault, toggled: [...workExpansion.toggled] }));
    } catch {
      // ignored
    }
  }, [safeStorage, workExpansion]);

  React.useEffect(() => {
    if (!activityCollapseDirty.current) return;
    try {
      safeStorage.setItem(ACTIVITY_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsedActivities)));
    } catch {
      // ignored
    }
  }, [collapsedActivities, safeStorage]);

  const updateCollapsedActivities = React.useCallback<React.Dispatch<React.SetStateAction<Set<string>>>>((update) => {
    activityCollapseDirty.current = true;
    setCollapsedActivities(update);
  }, []);

  const collapseAll = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    groupCollapseDirty.current = true;
    activityCollapseDirty.current = true;
    workExpansionDirty.current = true;
    setCollapsedGroups(new Set());
    setWorkExpansion({ expandedByDefault: false, toggled: new Set() });
    setCollapsedActivities((current) => new Set([...current, ...SIDEBAR_ACTIVITY_KEYS]));
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

  const expandAll = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    groupCollapseDirty.current = true;
    activityCollapseDirty.current = true;
    workExpansionDirty.current = true;
    setCollapsedGroups(new Set());
    setWorkExpansion({ expandedByDefault: true, toggled: new Set() });
    setCollapsedActivities((current) => {
      const next = new Set(current);
      for (const key of SIDEBAR_ACTIVITY_KEYS) next.delete(key);
      return next;
    });
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
  const toggleWork = React.useCallback((key: string) => {
    workExpansionDirty.current = true;
    setWorkExpansion((previous) => {
      const toggled = new Set(previous.toggled);
      if (toggled.has(key)) toggled.delete(key);
      else toggled.add(key);
      return { expandedByDefault: previous.expandedByDefault, toggled };
    });
  }, []);
  const state = React.useMemo(() => ({
    collapsedProjects,
    collapsedGroups,
    collapsedActivities,
    workExpansion,
  }), [collapsedActivities, collapsedGroups, collapsedProjects, workExpansion]);
  const actions = React.useMemo(() => ({
    setCollapsedProjects,
    toggleProject,
    collapseAll,
    expandAll,
    scheduleCollapsedProjectsPersist,
    setCollapsedGroups,
    setCollapsedActivities: updateCollapsedActivities,
    toggleGroup,
    toggleWork,
  }), [collapseAll, expandAll, scheduleCollapsedProjectsPersist, toggleGroup, toggleProject, toggleWork, updateCollapsedActivities]);

  return { state, actions };
};
