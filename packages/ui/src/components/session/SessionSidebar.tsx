import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useGitStore, useGitAllBranches, useGitRepoStatusMap } from '@/stores/useGitStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSessionSearchEffects } from './sidebar/shell/useSessionSearchEffects';
import { useSessionProjectViewState } from './sidebar/projects/useSessionProjectViewState';
import { useProjectRepoStatus } from './sidebar/projects/useProjectRepoStatus';
import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { SidebarHeader } from './sidebar/shell/SidebarHeader';
import { SidebarNav } from './sidebar/shell/SidebarNav';
import { SidebarFooter } from './sidebar/shell/SidebarFooter';
import { SessionProjectCollection } from './sidebar/list/SessionProjectCollection';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import {
  listProjectWorktrees,
  partitionWorktreesByRegisteredProject,
  worktreeMapsEqual,
} from '@/lib/worktrees/worktreeManager';
import { checkIsGitRepository } from '@/lib/gitApi';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { normalizePath } from './sidebar/utils';
import { recordWorktreesSeen } from './sidebar/projects/worktreeFirstSeen';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { streamPerfCount, streamPerfMark } from '@/stores/utils/streamDebug';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { buildKnownSessionDirectories } from './sidebar/list/sessionListDirectories';
import { z } from 'zod';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import {
  commitDiscoveredRawWorktreesByProject,
  ensureRawWorktreesByProjectScope,
  startSessionWorktreeMenuLoad,
  type RawWorktreesByProjectScope,
  type StartSessionWorktreeMenuLoadArgs,
} from './sidebar/sessionWorktreeMenu';
import { resolveProjectRef } from '@/lib/worktreeSessionCreator';

const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
const EMPTY_STRING_ARRAY: string[] = [];
const activeSessionByProjectSchema = z.record(z.string(), z.string().min(1).catch(''));

interface SessionSidebarProps {
  isVisible?: boolean;
  mobileVariant?: boolean;
  onSessionSelected?: (sessionId: string) => void;
  allowReselect?: boolean;
  hideDirectoryControls?: boolean;
  showOnlyMainWorkspace?: boolean;
}

const SessionSidebarComponent: React.FC<SessionSidebarProps> = ({
  isVisible = true,
  mobileVariant = false,
  onSessionSelected,
  allowReselect = false,
  hideDirectoryControls = false,
  showOnlyMainWorkspace = false,
}) => {
  streamPerfMark('react.session_sidebar_render');
  streamPerfCount('ui.session_sidebar.render');
  streamPerfCount(`ui.session_sidebar.render.${mobileVariant ? 'mobile' : 'desktop'}`);
  streamPerfCount(`ui.session_sidebar.render.${isVisible ? 'visible' : 'hidden'}`);
  const { t } = useI18n();
  const [isSessionSearchOpen, setIsSessionSearchOpen] = React.useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState('');
  // Reported by the session list below: the header cannot see what matched.
  const [searchMatchCount, setSearchMatchCount] = React.useState(0);
  const sessionSearchContainerRef = React.useRef<HTMLDivElement | null>(null);
  const sessionSearchInputRef = React.useRef<HTMLInputElement | null>(null);
  const [editingProjectDialogId, setEditingProjectDialogId] = React.useState<string | null>(null);
  const safeStorage = React.useMemo(() => getDeferredSafeStorage(), []);
  const [projectRepoStatus, setProjectRepoStatus] = React.useState<Map<string, boolean | null>>(new Map());
  const newWorktreeDialogOpen = useUIStore((state) => state.isNewWorktreeDialogOpen);
  const setNewWorktreeDialogOpen = useUIStore((state) => state.setNewWorktreeDialogOpen);
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(false);
  const initialActiveSessionByProject = React.useMemo<Map<string, string>>(() => {
    try {
      const raw = safeStorage.getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = activeSessionByProjectSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return new Map();
      const next = new Map<string, string>();
      Object.entries(parsed.data).forEach(([projectId, sessionId]) => {
        if (sessionId) next.set(projectId, sessionId);
      });
      return next;
    } catch {
      return new Map();
    }
  }, [safeStorage]);
  const persistActiveSessionByProject = React.useCallback((value: Map<string, string>) => {
    try {
      safeStorage.setItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(value.entries())));
    } catch { /* ignored */ }
  }, [safeStorage]);

  const [projectRootBranches, setProjectRootBranches] = React.useState<Map<string, string>>(new Map());

  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);

  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const toggleHelpDialog = useUIStore((state) => state.toggleHelpDialog);
  const setAboutDialogOpen = useUIStore((state) => state.setAboutDialogOpen);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const setScheduledTasksDialogOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const setArchivePageOpen = useUIStore((state) => state.setArchivePageOpen);
  const setWorktreesPageProjectId = useUIStore((state) => state.setWorktreesPageProjectId);
  const openMultiRunLauncher = useUIStore((state) => state.openMultiRunLauncher);
  const notifyOnSubtasks = useUIStore((state) => state.notifyOnSubtasks);

  const debouncedSessionSearchQuery = useDebouncedValue(sessionSearchQuery, 120);
  const normalizedSessionSearchQuery = React.useMemo(
    () => debouncedSessionSearchQuery.trim().toLowerCase(),
    [debouncedSessionSearchQuery],
  );

  const hasSessionSearchQuery = normalizedSessionSearchQuery.length > 0;


  useSessionSearchEffects({
    enabled: isVisible,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchContainerRef,
  });

  const gitBranches = useGitAllBranches(isVisible);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  // sessionAttentionStates removed — now using notification-store directly in SessionNodeItem
  const worktreeMetadata = useSessionUIStore((state) => state.worktreeMetadata);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const knownSessionDirectories = React.useMemo(
    () => buildKnownSessionDirectories(projects, availableWorktreesByProject, { includeWorktrees: !isVSCode }),
    [availableWorktreesByProject, isVSCode, projects],
  );
  // The sidebar tree's +-buttons (project / group / folder) open a draft but,
  // unlike selecting an existing session, don't navigate. VS Code's compact view
  // is driven by the openchamber:navigate event, so switch to chat explicitly
  // (a no-op in the expanded side-by-side layout, which is always showing chat).
  const openNewSessionDraftFromTree = React.useCallback<typeof openNewSessionDraft>((options) => {
    // Starting a draft always leaves any full-page surface, even when a
    // draft was already open (no store transition fires in that case).
    useUIStore.getState().closeMainSurfaces();
    openNewSessionDraft(options);
    if (isVSCode) {
      window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
    }
  }, [isVSCode, openNewSessionDraft]);
  const updateStore = useUpdateStore(useShallow((s) => ({
    checkForUpdates: s.checkForUpdates,
    available: s.available,
    runtimeType: s.runtimeType,
    info: s.info,
    downloading: s.downloading,
    downloaded: s.downloaded,
    progress: s.progress,
    error: s.error,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate,
  })));

  const runtimeKey = getRuntimeKey();
  const projectWorktreeDiscoveryKey = React.useMemo(
    () => `${runtimeKey}|${projects
      .map((project) => `${project.id}:${normalizePath(project.path) ?? ''}`)
      .join('|')}`,
    [projects, runtimeKey],
  );
  const [resolvedWorktreeTopologyKey, setResolvedWorktreeTopologyKey] = React.useState<string | null>(
    isVSCode ? projectWorktreeDiscoveryKey : null,
  );
  const [worktreeDiscoveryRevision, requestWorktreeDiscovery] = React.useReducer((revision) => revision + 1, 0);
  const isWorktreeTopologyLoading = !isVSCode && resolvedWorktreeTopologyKey !== projectWorktreeDiscoveryKey;
  const [unresolvedWorktreeProjectPaths, setUnresolvedWorktreeProjectPaths] = React.useState<ReadonlySet<string>>(new Set());
  const rawWorktreesByProjectRef = React.useRef<RawWorktreesByProjectScope>({
    runtimeKey: null,
    revision: 0,
    worktreesByProject: new Map(),
  });

  React.useEffect(() => {
    let cancelled = false;

    const discoverWorktrees = async () => {
      const discoveryRuntimeKey = runtimeKey;
      const projectEntries = useProjectsStore.getState().projects;
      if (projectEntries.length === 0 || isVSCode) {
        if (!cancelled) {
          rawWorktreesByProjectRef.current = {
            runtimeKey: null,
            revision: 0,
            worktreesByProject: new Map(),
          };
          setUnresolvedWorktreeProjectPaths(new Set());
          setResolvedWorktreeTopologyKey(projectWorktreeDiscoveryKey);
        }
        return;
      }

      const knownPublishedWorktreesByProject = useSessionUIStore.getState().availableWorktreesByProject;
      const seededRawScope = ensureRawWorktreesByProjectScope({
        rawWorktreesByProjectRef,
        publishedWorktreesByProject: knownPublishedWorktreesByProject,
        runtimeKey: discoveryRuntimeKey,
      });
      const capturedRawRevision = seededRawScope.revision;
      const worktreesByProject = new Map(seededRawScope.worktreesByProject);
      const unresolvedProjectPaths = new Set<string>();

      // Constrain fanout: previously `Promise.all(projects.map(...))` could
      // spawn dozens of concurrent `git worktree list` and
      // `checkIsGitRepository` calls on cold start, each touching the
      // worktree process. Concurrency=3 keeps startup latency low while
      // bounding peak worktree-process load.
      const worktreeConcurrency = 3;
      let cursor = 0;
      const workers = Array.from({ length: worktreeConcurrency }, async () => {
        while (true) {
          const nextIndex = cursor;
          cursor += 1;
          if (nextIndex >= projectEntries.length) return;
          const project = projectEntries[nextIndex];
          const projectPath = normalizePath(project.path);
          if (!projectPath) continue;
          try {
            const worktrees = await runBackgroundNetworkTask(async () => {
              // Use store-cached isGitRepo when available; fall back to
              // a direct check for projects the Git store hasn't seen yet.
              const cachedIsGitRepo = useGitStore.getState().directories.get(projectPath)?.isGitRepo;
              const isGitRepo = cachedIsGitRepo ?? await checkIsGitRepository(projectPath);
              if (!isGitRepo) return null;
              return listProjectWorktrees({ id: project.id, path: projectPath });
            });
            if (worktrees === null) {
              worktreesByProject.delete(projectPath);
              continue;
            }
            if (cancelled) return;
            if (worktrees.length === 0) {
              worktreesByProject.delete(projectPath);
            } else {
              worktreesByProject.set(projectPath, worktrees);
            }
          } catch {
            // Keep last-known worktrees when a project is temporarily unavailable.
            unresolvedProjectPaths.add(projectPath);
          }
        }
      });
      await Promise.all(workers);

      if (cancelled || getRuntimeKey() !== discoveryRuntimeKey) return;

      const activeProjectPaths = new Set(projectEntries.map((project) => normalizePath(project.path)).filter(Boolean));
      for (const projectPath of worktreesByProject.keys()) {
        if (!activeProjectPaths.has(projectPath)) {
          worktreesByProject.delete(projectPath);
        }
      }
      const committed = commitDiscoveredRawWorktreesByProject({
        rawWorktreesByProjectRef,
        runtimeKey: discoveryRuntimeKey,
        capturedRevision: capturedRawRevision,
        nextRawWorktreesByProject: worktreesByProject,
        publishedWorktreesByProject: knownPublishedWorktreesByProject,
        partitionWorktreesByRegisteredProject,
        projects: projectEntries,
        worktreeMapsEqual,
        recordWorktreesSeen,
        publishTopology: (next) => {
          useSessionUIStore.setState(next);
        },
        requestRediscovery: () => {
          requestWorktreeDiscovery();
        },
        now: () => Date.now(),
      });
      if (!committed) {
        return;
      }
      setUnresolvedWorktreeProjectPaths(unresolvedProjectPaths);
      setResolvedWorktreeTopologyKey(projectWorktreeDiscoveryKey);
    };

    void discoverWorktrees();

    return () => {
      cancelled = true;
    };
  }, [isVSCode, projectWorktreeDiscoveryKey, runtimeKey, worktreeDiscoveryRevision]);

  React.useEffect(() => {
    if (isVSCode) return;
    return subscribeOpenchamberEvents((event) => {
      if (event.type === 'session-created') requestWorktreeDiscovery();
    });
  }, [isVSCode]);

  const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);

  const { isTablet } = useDeviceInfo();
  const alwaysShowSidebarActions = mobileVariant || isTablet;


  const emptyState = React.useMemo(() => (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noSessions.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noSessions.description')}</p>
    </div>
  ), [t]);

  const editingProject = React.useMemo(
    () => projects.find((project) => project.id === editingProjectDialogId) ?? null,
    [projects, editingProjectDialogId],
  );

  const handleSaveProjectEdit = React.useCallback((data: {
    label: string;
    icon: string | null;
    color: string | null;
    iconBackground: string | null;
    defaultModel: string | null;
  }) => {
    if (!editingProjectDialogId) {
      return;
    }
    updateProjectMeta(editingProjectDialogId, {
      label: data.label,
      icon: data.icon,
      color: data.color,
      iconBackground: data.iconBackground,
      defaultModel: data.defaultModel ?? null,
    });
  }, [editingProjectDialogId, updateProjectMeta]);

  const openNewWorktreeDialog = React.useCallback(() => {
    setNewWorktreeDialogOpen(true);
  }, [setNewWorktreeDialogOpen]);

  const handleOpenUpdateDialog = React.useCallback(() => {
    const current = useUpdateStore.getState();
    if (current.available && current.info) {
      setUpdateDialogOpen(true);
      return;
    }

    void updateStore.checkForUpdates().then(() => {
      const { available, error } = useUpdateStore.getState();
      if (error) {
        toast.error(t('sessions.sidebar.updateCheck.errorTitle'), { description: error });
        return;
      }
      if (!available) {
        toast.success(t('sessions.sidebar.updateCheck.latestVersion'));
        return;
      }
      setUpdateDialogOpen(true);
    });
  }, [t, updateStore]);

  const handleOpenSettings = React.useCallback(() => {
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    setSettingsDialogOpen(true);
  }, [mobileVariant, setSessionSwitcherOpen, setSettingsDialogOpen]);

  const showSidebarUpdateButton =
    updateStore.available &&
    (updateStore.runtimeType === 'desktop' || updateStore.runtimeType === 'web');

  const handleOpenDirectoryDialog = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);


  const normalizedProjects = React.useMemo(() => {
    return projects.flatMap((project) => {
      const normalizedPath = normalizePath(project.path);
      if (!normalizedPath) return [];
      return [{
        id: project.id,
        path: project.path,
        label: project.label,
        normalizedPath,
        icon: project.icon ?? undefined,
        color: project.color ?? undefined,
        iconImage: project.iconImage ?? undefined,
        iconBackground: project.iconBackground ?? undefined,
        addedAt: project.addedAt,
        lastOpenedAt: project.lastOpenedAt,
        sidebarCollapsed: project.sidebarCollapsed,
      }];
    });
  }, [projects]);

  const normalizedProjectPaths = React.useMemo(
    () => normalizedProjects.map((project) => project.normalizedPath),
    [normalizedProjects],
  );

  const gitRepoStatus = useGitRepoStatusMap(isVisible ? normalizedProjectPaths : EMPTY_STRING_ARRAY);
  useProjectRepoStatus({
    enabled: isVisible,
    normalizedProjects,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  });

  const isSessionsLoading = useSessionUIStore((state) => state.isLoading);
  // Keep last-known repo status to avoid UI jiggling during project switch
  const lastRepoStatusRef = React.useRef(false);
  if (activeProjectId && projectRepoStatus.has(activeProjectId)) {
    lastRepoStatusRef.current = Boolean(projectRepoStatus.get(activeProjectId));
  }

  const showArchivedSessions = useSessionDisplayStore((state) => state.showArchivedSessions);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const stickyZoneHeaders = useSessionDisplayStore((state) => state.stickyZoneHeaders);
  const manualProjectOrder = useProjectsStore((state) => state.manualProjectOrder);

  const sidebarRenderSources = {
    isVisible,
    mobileVariant,
    onSessionSelected,
    allowReselect,
    hideDirectoryControls,
    showOnlyMainWorkspace,
    t,
    isTablet,
    projects,
    activeProjectId,
    manualProjectOrder,
    worktreeMetadata,
    availableWorktreesByProject,
    gitBranches,
    gitRepoStatus,
    updateStore,
    showArchivedSessions,
    projectSortOrder,
    projectRepoStatus,
    projectRootBranches,
    resolvedWorktreeTopologyKey,
    unresolvedWorktreeProjectPaths,
    isSessionSearchOpen,
    sessionSearchQuery,
    editingProjectDialogId,
    updateDialogOpen,
  };
  const previousSidebarRenderSourcesRef = React.useRef<typeof sidebarRenderSources | null>(null);
  const previousSidebarRenderSources = previousSidebarRenderSourcesRef.current;
  if (previousSidebarRenderSources) {
    let attributed = false;
    // SAFETY: Object.keys is constrained to the immediately constructed object's own keys.
    for (const source of Object.keys(sidebarRenderSources) as Array<keyof typeof sidebarRenderSources>) {
      if (!Object.is(previousSidebarRenderSources[source], sidebarRenderSources[source])) {
        streamPerfCount(`ui.session_sidebar.source.${source}`);
        attributed = true;
      }
    }
    if (!attributed) {
      streamPerfCount('ui.session_sidebar.source.parent_or_context');
    }
  }
  previousSidebarRenderSourcesRef.current = sidebarRenderSources;

  const sortedProjects = React.useMemo(() => {
    const list = [...normalizedProjects];

    switch (projectSortOrder) {
      case 'a-z':
        list.sort((a, b) => {
          const aLabel = (a.label || a.path).toLowerCase();
          const bLabel = (b.label || b.path).toLowerCase();
          return aLabel.localeCompare(bLabel);
        });
        break;
      case 'z-a':
        list.sort((a, b) => {
          const aLabel = (a.label || a.path).toLowerCase();
          const bLabel = (b.label || b.path).toLowerCase();
          return bLabel.localeCompare(aLabel);
        });
        break;
      case 'date-added':
        list.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
        break;
      case 'recent':
        list.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
        break;
      case 'manual': {
        const orderMap = new Map(manualProjectOrder.map((id, i) => [id, i]));
        list.sort((a, b) => {
          const ai = orderMap.get(a.id) ?? Infinity;
          const bi = orderMap.get(b.id) ?? Infinity;
          return ai - bi;
        });
        break;
      }
    }

    return list;
  }, [normalizedProjects, projectSortOrder, manualProjectOrder]);
  const projectView = useSessionProjectViewState({ isVSCode, projects: sortedProjects });

  const searchEmptyState = React.useMemo(() => (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noMatches.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noMatches.description')}</p>
    </div>
  ), [t]);

  // Web/desktop route archived sessions to the Archive page; only the VS Code
  // compact webview keeps inline archived buckets behind its toggle.
  const showInlineArchived = isVSCode && showArchivedSessions;
  // 'by-worktree' renders the worktree-grouped sections (parallel-work
  // overview); 'flat' renders the merged per-project list. VS Code has no
  // worktree groups, so both resolve to the same shape — use flat there.
  const sessionGroupingMode = useSessionDisplayStore((state) => state.sessionGroupingMode);
  const useGroupedSections = sessionGroupingMode === 'by-worktree' && !isVSCode;
  const desktopHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const mobileHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const headerActionButtonClass = mobileVariant ? mobileHeaderActionButtonClass : desktopHeaderActionButtonClass;
  const headerActionIconClass = 'h-4.5 w-4.5';

  const handleOpenMultiRunFromHeader = React.useCallback(() => {
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openMultiRunLauncher();
  }, [mobileVariant, openMultiRunLauncher, setSessionSwitcherOpen]);

  const handleSessionWorktreeMenuLoad = React.useCallback((args: StartSessionWorktreeMenuLoadArgs) => {
    const resolvedProject = args.projectId
      ? (projects.find((candidate) => candidate.id === args.projectId) ?? null)
      : (args.sourceDirectory ? resolveProjectRef(args.sourceDirectory) : null);
    return startSessionWorktreeMenuLoad(args, {
      projects,
      getCurrentProjects: () => useProjectsStore.getState().projects,
      rawWorktreesByProjectRef,
      getPublishedWorktreesByProject: () => useSessionUIStore.getState().availableWorktreesByProject,
      resolveProject: (directory) => resolveProjectRef(directory),
      listProjectWorktrees,
      partitionWorktreesByRegisteredProject,
      worktreeMapsEqual,
      recordWorktreesSeen,
      publishTopology: (next) => {
        useSessionUIStore.setState(next);
      },
      getRuntimeKey,
      now: () => Date.now(),
      projectRootBranch: resolvedProject ? (projectRootBranches.get(resolvedProject.id) ?? null) : null,
    });
  }, [projectRootBranches, projects]);

  const handleOpenNewSessionDraftFromHeader = React.useCallback(() => {
    useUIStore.getState().closeMainSurfaces();
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openNewSessionDraft();
  }, [mobileVariant, openNewSessionDraft, setSessionSwitcherOpen]);

  return (
    // One shared tooltip provider for the whole sidebar: session tooltips open
    // instantly, and moving between rows hands the tooltip over (grouping)
    // instead of replaying the exit/enter animation for each row.
    // closeDelay bridges the small gap between rows: the tooltip survives the
    // pointer crossing row margins, and the grouping timeout hands it over to
    // the next row without an exit/enter cycle.
    <TooltipProvider delay={0} closeDelay={150} timeout={600}>
    <div
      ref={sessionSearchContainerRef}
      className={cn(
        'relative flex h-full flex-col text-foreground overflow-x-hidden',
        mobileVariant ? '' : 'bg-transparent',
      )}
    >
      {!hideDirectoryControls && !isVSCode ? (
        <SidebarNav onNewSession={handleOpenNewSessionDraftFromHeader} />
      ) : null}

      <SidebarHeader
        hideDirectoryControls={hideDirectoryControls}
        showProjectDisplayControls={!isVSCode}
        showRecentControls={!isVSCode}
        handleOpenDirectoryDialog={handleOpenDirectoryDialog}
        onOpenScheduled={() => {
          if (mobileVariant) setSessionSwitcherOpen(false);
          setScheduledTasksDialogOpen(true);
        }}
        onOpenMultiRun={handleOpenMultiRunFromHeader}
        canOpenMultiRun={projects.length > 0}
        onOpenArchive={() => {
          if (mobileVariant) setSessionSwitcherOpen(false);
          setArchivePageOpen(true);
        }}
        headerActionIconClass={headerActionIconClass}
        headerActionButtonClass={headerActionButtonClass}
        isSessionSearchOpen={isSessionSearchOpen}
        setIsSessionSearchOpen={setIsSessionSearchOpen}
        sessionSearchInputRef={sessionSearchInputRef}
        sessionSearchQuery={sessionSearchQuery}
        setSessionSearchQuery={setSessionSearchQuery}
        hasSessionSearchQuery={hasSessionSearchQuery}
        searchMatchCount={searchMatchCount}
        collapseAllProjects={projectView.actions.collapseAllProjects}
        expandAllProjects={projectView.actions.expandAllProjects}
      />

      <SessionProjectCollection
        topology={{
          projects: sortedProjects,
          availableWorktreesByProject,
          knownDirectories: knownSessionDirectories,
          isVSCode,
          worktreeMetadata,
          gitBranches,
          projectRepoStatus,
          projectRootBranches,
          lastRepoStatus: lastRepoStatusRef.current,
        }}
        view={{
          isVisible,
          hasSessionSearchQuery,
          normalizedSessionSearchQuery,
          activeProjectId,
          showInlineArchived,
          useGroupedSections,
          homeDirectory,
          mobileVariant,
          hideDirectoryControls,
          showOnlyMainWorkspace,
          isDesktopShellRuntime,
          stickyZoneHeaders,
          projectSortOrder,
          emptyState,
          searchEmptyState,
          isSessionsLoading,
          isWorktreeTopologyLoading,
          unresolvedWorktreeProjectPaths,
          projectView: projectView.state,
          onSearchMatchCountChange: setSearchMatchCount,
        }}
        actions={{
          rowActions: {
            allowReselect,
            onSessionSelected,
            isSessionSearchOpen,
            sessionSearchQuery,
            setSessionSearchQuery,
            setIsSessionSearchOpen,
          },
          alwaysShowActions: alwaysShowSidebarActions,
          notifyOnSubtasks,
          setActiveProjectIdOnly,
          setSessionSwitcherOpen,
          openNewSessionDraft: openNewSessionDraftFromTree,
          openNewWorktreeDialog,
          openWorktreesPage: (projectId) => {
            if (mobileVariant) setSessionSwitcherOpen(false);
            setWorktreesPageProjectId(projectId);
          },
          openProjectEditDialog: setEditingProjectDialogId,
          removeProject,
          reorderProjects,
          startSessionWorktreeMenuLoad: handleSessionWorktreeMenuLoad,
          initialActiveSessionByProject,
          persistActiveSessionByProject,
          projectViewActions: projectView.actions,
        }}
      />

      <SidebarFooter
        onOpenSettings={handleOpenSettings}
        onOpenShortcuts={toggleHelpDialog}
        onOpenAbout={() => setAboutDialogOpen(true)}
        onOpenUpdate={handleOpenUpdateDialog}
        showRuntimeButtons={!isVSCode}
        showUpdateButton={showSidebarUpdateButton}
      />

      <UpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        info={updateStore.info}
        downloading={updateStore.downloading}
        downloaded={updateStore.downloaded}
        progress={updateStore.progress}
        error={updateStore.error}
        onDownload={updateStore.downloadUpdate}
        onRestart={updateStore.restartToUpdate}
        runtimeType={updateStore.runtimeType}
      />

      <ProjectEditDialog
        open={Boolean(editingProject)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProjectDialogId(null);
          }
        }}
        project={editingProject}
        onSave={handleSaveProjectEdit}
      />

      <NewWorktreeDialog
        open={newWorktreeDialogOpen}
        onOpenChange={setNewWorktreeDialogOpen}
        onWorktreeCreated={(worktreePath, options) => {
          useUIStore.getState().closeMainSurfaces();
          if (mobileVariant) {
            setSessionSwitcherOpen(false);
          }
          if (options?.sessionId) {
            setCurrentSession(options.sessionId, worktreePath);
            return;
          }
          openNewSessionDraft({ directoryOverride: worktreePath, preserveDirectoryOverride: true });
        }}
      />

    </div>
    </TooltipProvider>
  );
};

export const SessionSidebar = React.memo(SessionSidebarComponent);
