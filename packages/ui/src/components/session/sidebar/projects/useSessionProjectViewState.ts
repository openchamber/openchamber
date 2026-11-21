import React from 'react';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { z } from 'zod';
import { PROJECTS_CAPTION_COLLAPSE_KEY, SIDEBAR_ACTIVITY_KEYS, sidebarSectionActivityKey } from '../sessionSidebarRowModel';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const PENDING_PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse.pending';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const ACTIVITY_COLLAPSE_STORAGE_KEY = 'oc.sessions.activityCollapse';
const WORK_EXPAND_STORAGE_KEY = 'oc.sessions.workExpand';

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

export const isWorkExpanded = (expansion: WorkExpansion, key: string): boolean => (
  expansion.expandedByDefault !== expansion.toggled.has(key)
);

type Project = { id: string; sidebarCollapsed?: boolean };

type SessionProjectViewStateArgs = {
  isVSCode: boolean;
  projects: readonly Project[];
  writeSettings?: (changes: Partial<DesktopSettings>) => Promise<{ ok: boolean }>;
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

type ProjectCollapseChoices = { bulk: boolean | null; byProject: Map<string, boolean> };

const emptyProjectCollapseChoices = (): ProjectCollapseChoices => ({ bulk: null, byProject: new Map() });

const pendingChoicesKey = () => `${PENDING_PROJECT_COLLAPSE_STORAGE_KEY}:${encodeURIComponent(getRuntimeKey())}`;

const pendingChoicesSchema = z.object({ bulk: z.boolean().nullable(), byProject: z.array(z.tuple([z.string(), z.boolean()])) });

const readPendingChoices = (raw: string | null): ProjectCollapseChoices => {
  try {
    const parsed = raw ? pendingChoicesSchema.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success) return { bulk: parsed.data.bulk, byProject: new Map(parsed.data.byProject) };
  } catch {
    // A broken record holds no choices.
  }
  return emptyProjectCollapseChoices();
};

const applyProjectCollapseChoices = (projects: readonly Project[], choices: ProjectCollapseChoices): Set<string> => {
  const collapsed = new Set<string>();
  for (const project of projects) {
    const choice = choices.byProject.get(project.id) ?? choices.bulk ?? project.sidebarCollapsed === true;
    if (choice) collapsed.add(project.id);
  }
  return collapsed;
};

export const useSessionProjectViewState = ({
  isVSCode,
  projects,
  writeSettings = updateDesktopSettings,
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
  const latestCollapsedProjects = React.useRef(collapsedProjects);
  const awaitingServerProjects = React.useRef(!isVSCode && !useProjectsStore.getState().hasServerSnapshot);
  const [initialChoices] = React.useState(() => {
    if (awaitingServerProjects.current) return readPendingChoices(safeStorage.getItem(pendingChoicesKey()));
    safeStorage.removeItem(pendingChoicesKey());
    return emptyProjectCollapseChoices();
  });
  const choicesWhileAwaiting = React.useRef<ProjectCollapseChoices>(initialChoices);
  const hasServerSnapshot = useProjectsStore((store) => store.hasServerSnapshot);

  const rememberChoiceWhileAwaiting = React.useCallback((update: (choices: ProjectCollapseChoices) => ProjectCollapseChoices) => {
    if (!awaitingServerProjects.current) return;
    const choices = update(choicesWhileAwaiting.current);
    choicesWhileAwaiting.current = choices;
    try {
      safeStorage.setItem(pendingChoicesKey(), JSON.stringify({ bulk: choices.bulk, byProject: [...choices.byProject] }));
    } catch {
      // ignored
    }
  }, [safeStorage]);

  const saveCollapsedProjects = React.useCallback((collapsed: ReadonlySet<string>) => {
    try {
      safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsed)));
    } catch {
      // ignored
    }
    if (isVSCode || awaitingServerProjects.current) return;
    const nextProjects = useProjectsStore.getState().projects.map((project) => (
      project.sidebarCollapsed === collapsed.has(project.id) ? project : { ...project, sidebarCollapsed: collapsed.has(project.id) }
    ));
    useProjectsStore.setState({ projects: nextProjects });
    void writeSettings({ projects: nextProjects }).catch(() => {});
  }, [isVSCode, safeStorage, writeSettings]);

  const commitCollapsedProjects = React.useCallback((next: Set<string>) => {
    latestCollapsedProjects.current = next;
    setCollapsedProjects(next);
    saveCollapsedProjects(next);
  }, [saveCollapsedProjects]);

  React.useLayoutEffect(() => {
    if (!hasServerSnapshot || !awaitingServerProjects.current) return;
    awaitingServerProjects.current = false;
    const choices = choicesWhileAwaiting.current;
    choicesWhileAwaiting.current = emptyProjectCollapseChoices();
    safeStorage.removeItem(pendingChoicesKey());
    const adopted = applyProjectCollapseChoices(projects, choices);
    latestCollapsedProjects.current = adopted;
    setCollapsedProjects(adopted);
    if (choices.bulk !== null || choices.byProject.size > 0) saveCollapsedProjects(adopted);
  }, [hasServerSnapshot, projects, safeStorage, saveCollapsedProjects]);

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
    const customZoneKeys = useSessionDisplayStore.getState().sections.flatMap((entry) => (
      entry.kind === 'custom' && entry.grouping === 'time' ? [sidebarSectionActivityKey(entry.id)] : []
    ));
    setCollapsedActivities((current) => new Set([...current, ...SIDEBAR_ACTIVITY_KEYS, ...customZoneKeys]));
    rememberChoiceWhileAwaiting(() => ({ bulk: true, byProject: new Map() }));
    commitCollapsedProjects(new Set(projects.map((project) => project.id)));
  }, [commitCollapsedProjects, projects, rememberChoiceWhileAwaiting]);

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
      for (const key of current) if (key.startsWith('section:')) next.delete(key);
      next.delete(PROJECTS_CAPTION_COLLAPSE_KEY);
      return next;
    });
    rememberChoiceWhileAwaiting(() => ({ bulk: false, byProject: new Map() }));
    commitCollapsedProjects(new Set());
  }, [commitCollapsedProjects, rememberChoiceWhileAwaiting]);

  const toggleProject = React.useCallback((projectId: string) => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    const next = new Set(latestCollapsedProjects.current);
    const collapsed = !next.has(projectId);
    if (collapsed) next.add(projectId);
    else next.delete(projectId);
    rememberChoiceWhileAwaiting((choices) => ({ bulk: choices.bulk, byProject: new Map(choices.byProject).set(projectId, collapsed) }));
    commitCollapsedProjects(next);
  }, [commitCollapsedProjects, rememberChoiceWhileAwaiting]);

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
    toggleProject,
    collapseAll,
    expandAll,
    setCollapsedGroups,
    setCollapsedActivities: updateCollapsedActivities,
    toggleGroup,
    toggleWork,
  }), [collapseAll, expandAll, toggleGroup, toggleProject, toggleWork, updateCollapsedActivities]);

  return { state, actions };
};
