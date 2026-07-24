import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { formatDirectoryName, cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllSessionStatuses, useChildStoreManager } from '@/sync/sync-context';
import { getAllSyncSessionMap } from '@/sync/sync-refs';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSync } from '@/sync/use-sync';
import { SessionPrefetchEffect } from './sidebar/hooks/useSessionPrefetch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useGitStore, useGitAllBranches, useGitRepoStatusMap } from '@/stores/useGitStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { ScheduledTasksDialog } from './ScheduledTasksDialog';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useArchivedAutoFolders } from './sidebar/hooks/useArchivedAutoFolders';
import { useSessionSidebarSections } from './sidebar/hooks/useSessionSidebarSections';
import { ProjectSessionSelectionEffect } from './sidebar/hooks/useProjectSessionSelection';
import { useGroupOrdering } from './sidebar/hooks/useGroupOrdering';
import { useSessionGrouping } from './sidebar/hooks/useSessionGrouping';
import { useSessionSearchEffects } from './sidebar/hooks/useSessionSearchEffects';
import { useSessionActions } from './sidebar/hooks/useSessionActions';
import { useSidebarPersistence } from './sidebar/hooks/useSidebarPersistence';
import { useProjectRepoStatus } from './sidebar/hooks/useProjectRepoStatus';
import { useProjectSessionLists } from './sidebar/hooks/useProjectSessionLists';
import { useAuthoritativeSessionCleanup } from './sidebar/hooks/useAuthoritativeSessionCleanup';
import { createSessionOwnershipIndex } from './sidebar/sessionOwnership';
import { useStickyProjectHeaders } from './sidebar/hooks/useStickyProjectHeaders';
import { getGitHubPrStatusKey, usePrVisualSummaryByKeys, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { SessionGroupSection } from './sidebar/SessionGroupSection';
import { SidebarHeader } from './sidebar/SidebarHeader';
import { SidebarActivitySections } from './sidebar/SidebarActivitySections';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarProjectsList } from './sidebar/SidebarProjectsList';
import { SessionNodeItem } from './sidebar/SessionNodeItem';
import type { SessionNodeRenderExtras } from './sidebar/sessionNodeItemUtils';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import { listProjectWorktrees, worktreeMapsEqual } from '@/lib/worktrees/worktreeManager';
import { checkIsGitRepository } from '@/lib/gitApi';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SortableDragHandleProps } from './sidebar/sortableItems';
import {
  BulkSessionDeleteConfirmDialog,
  FolderDeleteConfirmDialog,
  SessionDeleteConfirmDialog,
  type BulkDeleteSessionsConfirmState,
  type DeleteFolderConfirmState,
  type DeleteSessionConfirmState,
} from './sidebar/ConfirmDialogs';
import { BulkActionBar } from './sidebar/BulkActionBar';
import { useSidebarBulkActions } from './sidebar/hooks/useSidebarBulkActions';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useNotificationStore } from '@/sync/notification-store';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { type SessionGroup, type SessionNode } from './sidebar/types';
import {
  deriveRecentSessions,
} from './sidebar/activitySections';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import {
  formatProjectLabel,
  normalizePath,
  selectExpandedParentKeysForContext,
  toggleExpandedParentKey,
} from './sidebar/utils';
import {
  compareSessionsByLifecycleOrder,
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import {
  refreshGlobalSessions,
  refreshGlobalSessionsForDirectories,
  getSessionStructuralSignature,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { buildSessionBootstrapDemands } from './sidebar/sessionBootstrapDemands';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { streamPerfCount, streamPerfMark } from '@/stores/utils/streamDebug';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_ORDER_STORAGE_KEY = 'oc.sessions.groupOrder';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
// v3 holds composite "${renderContext}:${active|archived}:${sessionId}"
// entries so the same session in different render contexts (e.g. "Recent"
// and a project's root) has independent expand state. Older expansion state
// mixed contexts and is intentionally not migrated.
const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents.v3';

type PrVisualState = 'draft' | 'open' | 'blocked' | 'merged' | 'closed';

type PrIndicator = {
  visualState: PrVisualState;
  number: number;
  url: string | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  title: string | null;
  base: string | null;
  head: string | null;
  checks: {
    state: 'success' | 'failure' | 'pending' | 'unknown';
    total: number;
    success: number;
    failure: number;
    pending: number;
  } | null;
  canMerge: boolean | null;
  mergeableState: string | null;
  repo: {
    owner: string;
    repo: string;
  } | null;
};

const buildKnownSessionDirectories = (
  projects: Array<{ path: string }>,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  options?: { includeWorktrees?: boolean },
): Set<string> => {
  const directories = new Set<string>();
  for (const project of projects) {
    const normalized = normalizePath(project.path)?.toLowerCase();
    if (normalized) directories.add(normalized);
  }
  if (options?.includeWorktrees === false) {
    return directories;
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    for (const worktree of worktrees) {
      const normalized = normalizePath(worktree.path)?.toLowerCase();
      if (normalized) directories.add(normalized);
    }
  }
  return directories;
};

const isKnownActiveSessionDirectory = (
  session: Session,
  knownDirectories: Set<string>,
  options?: { allowUnknownDirectory?: boolean; allowEmptyDirectorySet?: boolean },
): boolean => {
  if (session.time?.archived) return true;
  const directory = normalizePath(resolveGlobalSessionDirectory(session))?.toLowerCase();
  if (!directory) return options?.allowUnknownDirectory ?? true;
  if (knownDirectories.size === 0) return options?.allowEmptyDirectorySet ?? true;
  return knownDirectories.has(directory);
};

const SIDEBAR_PR_NO_PR_RETRY_MS = 5 * 60_000;

const EMPTY_SUBTREE_SET: Set<string> = new Set();
const EMPTY_STRING_ARRAY: string[] = [];

const useStableRenderCallback = <Args extends unknown[], Return>(handler: (...args: Args) => Return): ((...args: Args) => Return) => {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  return React.useCallback((...args: Args) => handlerRef.current(...args), []);
};

interface SessionSidebarProps {
  isVisible?: boolean;
  mobileVariant?: boolean;
  onSessionSelected?: (sessionId: string) => void;
  allowReselect?: boolean;
  hideDirectoryControls?: boolean;
  showOnlyMainWorkspace?: boolean;
}

const SidebarBootstrapDemandEffect: React.FC<{
  owner: string;
  childStores: ReturnType<typeof useChildStoreManager>;
  projectSections: Parameters<typeof buildSessionBootstrapDemands>[0]['projectSections'];
  activeProjectId: string | null;
  collapsedProjects: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  currentDirectory: string | null;
}> = ({
  owner,
  childStores,
  projectSections,
  activeProjectId,
  collapsedProjects,
  collapsedGroups,
  currentDirectory,
}) => {
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);

  React.useEffect(() => {
    childStores.setBootstrapDemand(owner, buildSessionBootstrapDemands({
      projectSections,
      activeProjectId,
      collapsedProjects,
      collapsedGroups,
      currentDirectory,
      currentSessionDirectory,
    }));
  }, [
    activeProjectId,
    childStores,
    collapsedGroups,
    collapsedProjects,
    currentDirectory,
    currentSessionDirectory,
    owner,
    projectSections,
  ]);

  React.useEffect(
    () => () => childStores.clearBootstrapDemand(owner),
    [childStores, owner],
  );

  return null;
};

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
  const sessionSearchContainerRef = React.useRef<HTMLDivElement | null>(null);
  const sessionSearchInputRef = React.useRef<HTMLInputElement | null>(null);
  const retriedNoPrStatusKeysRef = React.useRef<Set<string>>(new Set());
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editingProjectDialogId, setEditingProjectDialogId] = React.useState<string | null>(null);
  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const safeStorage = React.useMemo(() => getDeferredSafeStorage(), []);
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(new Set());

  const [projectRepoStatus, setProjectRepoStatus] = React.useState<Map<string, boolean | null>>(new Map());
  const [visibleSessionCountByGroup, setVisibleSessionCountByGroup] = React.useState<Map<string, number>>(new Map());
  const newWorktreeDialogOpen = useUIStore((state) => state.isNewWorktreeDialogOpen);
  const setNewWorktreeDialogOpen = useUIStore((state) => state.setNewWorktreeDialogOpen);
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(false);
  const [openSidebarMenuKey, setOpenSidebarMenuKey] = React.useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = React.useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = React.useState('');
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<DeleteSessionConfirmState>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState<BulkDeleteSessionsConfirmState>(null);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => isVisible ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [isVisible],
  ));
  const activeSessionIds = useGlobalSessionStatusStore(useShallow(
    (state) => isVisible ? [...state.statusById.keys()].sort() : EMPTY_STRING_ARRAY,
  ));
  const activeSessionIdSet = React.useMemo(() => new Set(activeSessionIds), [activeSessionIds]);
  const togglePinnedSession = useSessionPinnedStore((state) => state.toggle);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
    try {
      const raw = getDeferredSafeStorage().getItem(GROUP_COLLAPSE_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [groupOrderByProject, setGroupOrderByProject] = React.useState<Map<string, string[]>>(() => {
    try {
      const raw = getDeferredSafeStorage().getItem(GROUP_ORDER_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      const next = new Map<string, string[]>();
      Object.entries(parsed).forEach(([projectId, order]) => {
        if (Array.isArray(order)) {
          next.set(projectId, order.filter((item) => typeof item === 'string'));
        }
      });
      return next;
    } catch {
      return new Map();
    }
  });
  const initialActiveSessionByProject = React.useMemo<Map<string, string>>(() => {
    try {
      const raw = getDeferredSafeStorage().getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string>;
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
  }, []);
  const persistActiveSessionByProject = React.useCallback((value: Map<string, string>) => {
    try {
      safeStorage.setItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(value.entries())));
    } catch { /* ignored */ }
  }, [safeStorage]);

  const [projectRootBranches, setProjectRootBranches] = React.useState<Map<string, string>>(new Map());
  const projectHeaderSentinelRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());
  const ignoreIntersectionUntil = React.useRef<number>(0);

  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);

  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const toggleHelpDialog = useUIStore((state) => state.toggleHelpDialog);
  const setAboutDialogOpen = useUIStore((state) => state.setAboutDialogOpen);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const setScheduledTasksDialogOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const openMultiRunLauncher = useUIStore((state) => state.openMultiRunLauncher);
  const notifyOnSubtasks = useUIStore((state) => state.notifyOnSubtasks);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);

  const debouncedSessionSearchQuery = useDebouncedValue(sessionSearchQuery, 120);
  const normalizedSessionSearchQuery = React.useMemo(
    () => debouncedSessionSearchQuery.trim().toLowerCase(),
    [debouncedSessionSearchQuery],
  );

  const hasSessionSearchQuery = normalizedSessionSearchQuery.length > 0;

  // Session Folders store
  const collapsedFolderIds = useSessionFoldersStore((state) => state.collapsedFolderIds);
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const getFoldersForScope = useSessionFoldersStore((state) => state.getFoldersForScope);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const addSessionsToFolder = useSessionFoldersStore((state) => state.addSessionsToFolder);
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const removeSessionsFromFolders = useSessionFoldersStore((state) => state.removeSessionsFromFolders);
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);

  useSessionSearchEffects({
    enabled: isVisible,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchContainerRef,
  });

  const gitBranches = useGitAllBranches(isVisible);

  const sync = useSync();
  const liveSessionStatuses = useAllSessionStatuses();
  const globalSessionStatusById = useGlobalSessionStatusStore((state) => state.statusById);
  const unseenCountBySessionId = useNotificationStore((state) => state.index.session.unseenCount);
  const childStores = useChildStoreManager();
  const bootstrapDemandOwner = `session-sidebar:${React.useId()}`;
  const liveSessionIndex = getAllSyncSessionMap();
  const liveSessions = React.useMemo(() => Array.from(liveSessionIndex.values()), [liveSessionIndex]);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const hasAuthoritativeGlobalSessions = useGlobalSessionsStore((state) => state.status === 'ready');
  const activeSessionStructure = useGlobalSessionsStore(useShallow(
    (state) => state.activeSessions.map(getSessionStructuralSignature).sort(),
  ));
  const archivedSessionStructure = useGlobalSessionsStore(useShallow(
    (state) => state.archivedSessions.map(getSessionStructuralSignature).sort(),
  ));
  const globalSessionSnapshot = useGlobalSessionsStore.getState();
  const globalActiveSessions = globalSessionSnapshot.activeSessions;
  const archivedSessions = globalSessionSnapshot.archivedSessions;
  const liveFallbackCacheRef = React.useRef<{ signature: string; sessions: Session[] }>({
    signature: '',
    sessions: [],
  });
  const globalActiveSessionIds = React.useMemo(
    () => new Set(globalActiveSessions.map((session) => session.id)),
    [globalActiveSessions],
  );
  const liveFallbackSessions = (() => {
    const candidates = liveSessions.filter((session) => !globalActiveSessionIds.has(session.id));
    const signature = candidates.map(getSessionStructuralSignature).sort().join('\n');
    if (liveFallbackCacheRef.current.signature === signature) {
      return liveFallbackCacheRef.current.sessions;
    }
    liveFallbackCacheRef.current = { signature, sessions: candidates };
    return candidates;
  })();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  // sessionAttentionStates removed — now using notification-store directly in SessionNodeItem
  const worktreeMetadata = useSessionUIStore((state) => state.worktreeMetadata);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  // The sidebar tree's +-buttons (project / group / folder) open a draft but,
  // unlike selecting an existing session, don't navigate. VS Code's compact view
  // is driven by the openchamber:navigate event, so switch to chat explicitly
  // (a no-op in the expanded side-by-side layout, which is always showing chat).
  const openNewSessionDraftFromTree = React.useCallback<typeof openNewSessionDraft>((options) => {
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

  const knownSessionDirectories = React.useMemo(
    () => buildKnownSessionDirectories(projects, availableWorktreesByProject, { includeWorktrees: !isVSCode }),
    [availableWorktreesByProject, isVSCode, projects],
  );

  const sessions = React.useMemo(() => {
    const merged = [...globalActiveSessions];
    const seenIds = new Set(merged.map((session) => session.id));

    liveFallbackSessions.forEach((session) => {
      if (seenIds.has(session.id)) {
        return;
      }
      merged.push(session);
    });

    return merged.filter((session) => isKnownActiveSessionDirectory(session, knownSessionDirectories, {
      allowUnknownDirectory: !isVSCode,
      allowEmptyDirectorySet: !isVSCode,
    }));
  }, [globalActiveSessions, isVSCode, knownSessionDirectories, liveFallbackSessions]);

  const persistenceSessions = React.useMemo(
    () => [...globalActiveSessions, ...archivedSessions],
    [archivedSessions, globalActiveSessions],
  );

  const syncSessionsSnapshotRef = React.useRef<Session[]>(liveSessions);
  React.useEffect(() => {
    syncSessionsSnapshotRef.current = liveSessions;
  }, [liveSessions]);

  const activeActivitySessionIds = React.useMemo(() => {
    const ids = new Set<string>();
    Object.entries(liveSessionStatuses).forEach(([sessionId, status]) => {
      if (status?.type === 'busy' || status?.type === 'retry') {
        ids.add(sessionId);
      }
    });
    globalSessionStatusById.forEach((entry, sessionId) => {
      if (entry.status.type === 'busy' || entry.status.type === 'retry') {
        ids.add(sessionId);
      }
    });
    return ids;
  }, [globalSessionStatusById, liveSessionStatuses]);

  const unreadActivitySessionIds = React.useMemo(() => {
    const ids = new Set<string>();
    Object.entries(unseenCountBySessionId).forEach(([sessionId, count]) => {
      if (count > 0) {
        ids.add(sessionId);
      }
    });
    return ids;
  }, [unseenCountBySessionId]);

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
  const isWorktreeTopologyLoading = !isVSCode && resolvedWorktreeTopologyKey !== projectWorktreeDiscoveryKey;
  const [unresolvedWorktreeProjectPaths, setUnresolvedWorktreeProjectPaths] = React.useState<ReadonlySet<string>>(new Set());

  const initialGlobalSessionsRefreshStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (initialGlobalSessionsRefreshStartedRef.current) {
      return;
    }
    initialGlobalSessionsRefreshStartedRef.current = true;
    void refreshGlobalSessions(syncSessionsSnapshotRef.current);
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    const discoverWorktrees = async () => {
      const discoveryRuntimeKey = runtimeKey;
      const projectEntries = useProjectsStore.getState().projects;
      if (projectEntries.length === 0 || isVSCode) {
        if (!cancelled) {
          setUnresolvedWorktreeProjectPaths(new Set());
          setResolvedWorktreeTopologyKey(projectWorktreeDiscoveryKey);
        }
        return;
      }

      const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
      const worktreesByProject = new Map(currentByProject);
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
            // Use store-cached isGitRepo when available; fall back to
            // a direct check for projects the Git store hasn't seen yet.
            // Forcing `ensureStatus` here also warms the store so the
            // PR/render paths downstream can read isGitRepo for free.
            const cachedIsGitRepo = useGitStore.getState().directories.get(projectPath)?.isGitRepo;
            const isGitRepo = cachedIsGitRepo ?? await checkIsGitRepository(projectPath);
            if (!isGitRepo) {
              worktreesByProject.delete(projectPath);
              continue;
            }
            const worktrees = await listProjectWorktrees({ id: project.id, path: projectPath });
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
      const allWorktrees = [...worktreesByProject.values()].flat();

      // Skip update if nothing changed — see worktreeMapsEqual JSDoc.
      if (!worktreeMapsEqual(worktreesByProject, currentByProject)) {
        useSessionUIStore.setState({
          availableWorktrees: allWorktrees,
          availableWorktreesByProject: worktreesByProject,
        });
      }
      setUnresolvedWorktreeProjectPaths(unresolvedProjectPaths);
      setResolvedWorktreeTopologyKey(projectWorktreeDiscoveryKey);
    };

    void discoverWorktrees();

    return () => {
      cancelled = true;
    };
  }, [isVSCode, projectWorktreeDiscoveryKey, runtimeKey]);

  React.useEffect(() => {
    let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'scheduled-task-ran') {
        return;
      }
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      refreshTimeout = setTimeout(() => {
        void refreshGlobalSessions(syncSessionsSnapshotRef.current);
      }, 500);
    });
    return () => {
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      unsubscribe();
    };
  }, []);

  const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);

  const { isTablet } = useDeviceInfo();
  const alwaysShowSidebarActions = mobileVariant || isTablet;

  const {
    buildGroupSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  } = useSessionGrouping({
    homeDirectory,
    worktreeMetadata,
    pinnedSessionIds,
    sessionOrderRanks,
    gitBranches,
    isVSCode,
  });

  const { scheduleCollapsedProjectsPersist } = useSidebarPersistence({
    isVSCode,
    safeStorage,
    keys: {
      sessionExpanded: SESSION_EXPANDED_STORAGE_KEY,
      projectCollapse: PROJECT_COLLAPSE_STORAGE_KEY,
      groupOrder: GROUP_ORDER_STORAGE_KEY,
      groupCollapse: GROUP_COLLAPSE_STORAGE_KEY,
    },
    groupOrderByProject,
    collapsedGroups,
    setExpandedParents,
    setCollapsedProjects,
  });

  const orderedSessions = React.useMemo(() => {
    return orderSessionsByLifecycleScopes(sessions, pinnedSessionIds, sessionOrderRanks);
  }, [pinnedSessionIds, sessionOrderRanks, sessions]);

  // Reuse the index while the ordered IDs stay unchanged.
  // Without this, a fresh `orderedSessions` array (cheap to rebuild) would
  // still hand a new Map identity to the entire SessionGroupSection
  // memo chain, invalidating sourceGroupNodes, nodeBySessionId, and the
  // rest of the down-stream useMemo chain.
  const sessionOrderSignature = React.useMemo(
    () => orderedSessions.map((session) => session.id).join('|'),
    [orderedSessions],
  );

  const sessionOrderIndexRef = React.useRef<{ signature: string; map: Map<string, number> } | null>(null);
  const sessionOrderIndex = React.useMemo(() => {
    const cached = sessionOrderIndexRef.current;
    if (cached && cached.signature === sessionOrderSignature) {
      return cached.map;
    }
    const next = new Map(orderedSessions.map((session, index) => [session.id, index]));
    sessionOrderIndexRef.current = { signature: sessionOrderSignature, map: next };
    return next;
  }, [orderedSessions, sessionOrderSignature]);

  const childrenMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    orderedSessions.forEach((session) => {
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) {
        return;
      }
      const collection = map.get(parentID) ?? [];
      collection.push(session);
      map.set(parentID, collection);
    });
    map.forEach((list) => list.sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks)));
    return map;
  }, [orderedSessions, pinnedSessionIds, sessionOrderRanks]);

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

  const deleteSession = useSessionUIStore((state) => state.deleteSession);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);

  const {
    copiedSessionId,
    handleSessionSelect,
    handleSessionDoubleClick,
    handleSaveEdit,
    handleCancelEdit,
    handleShareSession,
    handleCopyShareUrl,
    handleUnshareSession,
    handleDeleteSession,
    confirmDeleteSession,
  } = useSessionActions({
    mobileVariant,
    allowReselect,
    onSessionSelected,
    isSessionSearchOpen,
    sessionSearchQuery,
    setSessionSearchQuery,
    setIsSessionSearchOpen,
    setActiveMainTab,
    setSessionSwitcherOpen,
    setCurrentSession,
    updateSessionTitle,
    shareSession,
    unshareSession,
    deleteSession,
    deleteSessions,
    archiveSession,
    archiveSessions,
    childrenMap,
    showDeletionDialog,
    setDeleteSessionConfirm,
    deleteSessionConfirm,
    setEditingId,
    setEditTitle,
    editingId,
    editTitle,
  });

  const confirmDeleteFolder = React.useCallback(() => {
    if (!deleteFolderConfirm) return;
    const { scopeKey, folderId } = deleteFolderConfirm;
    setDeleteFolderConfirm(null);
    deleteFolder(scopeKey, folderId);
  }, [deleteFolderConfirm, deleteFolder]);

  const handleOpenDirectoryDialog = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

  const toggleParent = React.useCallback((expansionKey: string) => {
    setExpandedParents((previous) => {
      const next = toggleExpandedParentKey(previous, expansionKey);
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [safeStorage]);

  const createFolderAndStartRename = React.useCallback(
    (scopeKey: string, parentId?: string | null) => {
      if (!scopeKey) {
        return null;
      }

      if (parentId && collapsedFolderIds.has(parentId)) {
        toggleFolderCollapse(parentId);
      }

      const newFolder = createFolder(scopeKey, t('sessions.sidebar.folder.newFolderName'), parentId);
      setRenamingFolderId(newFolder.id);
      setRenameFolderDraft(newFolder.name);
      return newFolder;
    },
    [collapsedFolderIds, toggleFolderCollapse, createFolder, t],
  );

  const stableHandleSessionSelect = useStableRenderCallback(handleSessionSelect);
  const stableHandleSessionDoubleClick = useStableRenderCallback(handleSessionDoubleClick);
  const stableHandleSaveEdit = useStableRenderCallback(handleSaveEdit);
  const stableHandleCancelEdit = useStableRenderCallback(handleCancelEdit);
  const stableHandleShareSession = useStableRenderCallback(handleShareSession);
  const stableHandleCopyShareUrl = useStableRenderCallback(handleCopyShareUrl);
  const stableHandleUnshareSession = useStableRenderCallback(handleUnshareSession);
  const stableHandleDeleteSession = useStableRenderCallback(handleDeleteSession);
  const stableCreateFolderAndStartRename = useStableRenderCallback(createFolderAndStartRename);

  const showMoreGroupSessions = React.useCallback((groupId: string, currentVisibleCount: number) => {
    setVisibleSessionCountByGroup((prev) => {
      const next = new Map(prev);
      next.set(groupId, currentVisibleCount + 7);
      return next;
    });
  }, []);

  const resetGroupSessionLimit = React.useCallback((groupId: string) => {
    setVisibleSessionCountByGroup((prev) => {
      if (!prev.has(groupId)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(groupId);
      return next;
    });
  }, []);

  const resetProjectSessionLimits = React.useCallback((projectId: string) => {
    setVisibleSessionCountByGroup((prev) => {
      let changed = false;
      const next = new Map(prev);
      const projectGroupPrefix = `${projectId}:`;
      for (const groupId of next.keys()) {
        if (groupId.startsWith(projectGroupPrefix)) {
          next.delete(groupId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const collapseAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    setVisibleSessionCountByGroup(new Map());
    setCollapsedProjects(() => {
      const allIds = new Set(projects.map((p) => p.id));
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(allIds)));
      } catch { /* ignored */ }
      if (!isVSCode) {
        scheduleCollapsedProjectsPersist(allIds);
      }
      return allIds;
    });
  }, [projects, isVSCode, safeStorage, scheduleCollapsedProjectsPersist]);

  const expandAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    setVisibleSessionCountByGroup(new Map());
    setCollapsedProjects(() => {
      const empty = new Set<string>();
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify([]));
      } catch { /* ignored */ }
      if (!isVSCode) {
        scheduleCollapsedProjectsPersist(empty);
      }
      return empty;
    });
  }, [isVSCode, safeStorage, scheduleCollapsedProjectsPersist]);

  const toggleProject = React.useCallback((projectId: string) => {
    // Ignore intersection events for a short period after toggling
    ignoreIntersectionUntil.current = Date.now() + 150;
    resetProjectSessionLimits(projectId);
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }

      // Persist collapse state to server settings (web + desktop local/remote).
      if (!isVSCode) {
        scheduleCollapsedProjectsPersist(next);
      }
      return next;
    });
  }, [isVSCode, resetProjectSessionLimits, safeStorage, scheduleCollapsedProjectsPersist]);

  const normalizedProjects = React.useMemo(() => {
    return projects
      .map((project) => ({
        ...project,
        normalizedPath: normalizePath(project.path),
      }))
      .filter((project) => Boolean(project.normalizedPath)) as Array<{
        id: string;
        path: string;
        label?: string;
        normalizedPath: string;
        icon?: string;
        color?: string;
        iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
        iconBackground?: string;
        addedAt?: number;
        lastOpenedAt?: number;
        sidebarCollapsed?: boolean;
      }>;
  }, [projects]);

  const normalizedProjectPaths = React.useMemo(
    () => normalizedProjects.map((project) => project.normalizedPath),
    [normalizedProjects],
  );

  const projectSessionDirectories = React.useMemo(() => {
    const directories = new Set(normalizedProjects.map((project) => project.normalizedPath));
    if (!isVSCode) {
      for (const worktrees of availableWorktreesByProject.values()) {
        for (const worktree of worktrees) {
          const directory = normalizePath(worktree.path);
          if (directory) directories.add(directory);
        }
      }
    }
    return [...directories].sort();
  }, [availableWorktreesByProject, isVSCode, normalizedProjects]);

  const knownProjectSessionDirectoriesRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    const nextDirectories = new Set(projectSessionDirectories);
    const previousDirectories = knownProjectSessionDirectoriesRef.current;
    knownProjectSessionDirectoriesRef.current = nextDirectories;
    if (!previousDirectories) {
      if (isVSCode && projectSessionDirectories.length > 0) {
        void refreshGlobalSessionsForDirectories(projectSessionDirectories, syncSessionsSnapshotRef.current);
      }
      return;
    }

    const addedDirectories = projectSessionDirectories.filter((directory) => !previousDirectories.has(directory));
    if (addedDirectories.length === 0) {
      return;
    }

    void refreshGlobalSessionsForDirectories(addedDirectories, syncSessionsSnapshotRef.current);
  }, [isVSCode, projectSessionDirectories]);

  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const gitRepoStatus = useGitRepoStatusMap(isVisible ? normalizedProjectPaths : EMPTY_STRING_ARRAY);
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshPrStatusTargets = useGitHubPrStatusStore((state) => state.refreshTargets);

  useProjectRepoStatus({
    enabled: isVisible,
    normalizedProjects,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  });

  const isSessionsLoading = useSessionUIStore((state) => state.isLoading);
  const sessionOwnership = React.useMemo(
    () => createSessionOwnershipIndex(sessions, normalizedProjects, availableWorktreesByProject, isVSCode, archivedSessions),
    [archivedSessions, availableWorktreesByProject, isVSCode, normalizedProjects, sessions],
  );
  useAuthoritativeSessionCleanup({
    enabled: isVisible,
    hasAuthoritativeGlobalSessions,
    sessions: persistenceSessions,
  });

  const { getSessionsForProject, getArchivedSessionsForProject } = useProjectSessionLists({
    ownership: sessionOwnership,
  });

  useArchivedAutoFolders({
    enabled: isVisible,
    normalizedProjects,
    ownership: sessionOwnership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading,
    unresolvedWorktreeProjectPaths,
    foldersMap,
    createFolder,
    addSessionToFolder,
  });

  // Keep last-known repo status to avoid UI jiggling during project switch
  const lastRepoStatusRef = React.useRef(false);
  if (activeProjectId && projectRepoStatus.has(activeProjectId)) {
    lastRepoStatusRef.current = Boolean(projectRepoStatus.get(activeProjectId));
  }

  const showRecentSection = useSessionDisplayStore((state) => state.showRecentSection);
  const showArchivedSessions = useSessionDisplayStore((state) => state.showArchivedSessions);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const manualProjectOrder = useProjectsStore((state) => state.manualProjectOrder);
  const projectExpandedParentsRef = React.useRef<Set<string>>(new Set());
  const recentExpandedParentsRef = React.useRef<Set<string>>(new Set());
  const projectExpandedParents = selectExpandedParentKeysForContext(
    projectExpandedParentsRef.current,
    expandedParents,
    'project',
  );
  const recentExpandedParents = selectExpandedParentKeysForContext(
    recentExpandedParentsRef.current,
    expandedParents,
    'recent',
  );
  projectExpandedParentsRef.current = projectExpandedParents;
  recentExpandedParentsRef.current = recentExpandedParents;

  const sidebarRenderSources = {
    isVisible,
    mobileVariant,
    onSessionSelected,
    allowReselect,
    hideDirectoryControls,
    showOnlyMainWorkspace,
    t,
    isTablet,
    liveSessions,
    activeSessionStructure,
    archivedSessionStructure,
    globalActiveSessions,
    archivedSessions,
    projects,
    activeProjectId,
    manualProjectOrder,
    currentDirectory,
    worktreeMetadata,
    availableWorktreesByProject,
    pinnedSessionIds,
    sessionOrderRanks,
    foldersMap,
    collapsedFolderIds,
    gitBranches,
    gitRepoStatus,
    githubAuthStatus,
    githubAuthChecked,
    updateStore,
    showRecentSection,
    showArchivedSessions,
    projectSortOrder,
    projectRepoStatus,
    projectRootBranches,
    resolvedWorktreeTopologyKey,
    unresolvedWorktreeProjectPaths,
    isSessionSearchOpen,
    sessionSearchQuery,
    editingId,
    editTitle,
    editingProjectDialogId,
    expandedParents,
    collapsedProjects,
    visibleSessionCountByGroup,
    updateDialogOpen,
    openSidebarMenuKey,
    renamingFolderId,
    renameFolderDraft,
    deleteSessionConfirm,
    deleteFolderConfirm,
    bulkDeleteConfirm,
    collapsedGroups,
    groupOrderByProject,
  };
  const previousSidebarRenderSourcesRef = React.useRef<typeof sidebarRenderSources | null>(null);
  const previousSidebarRenderSources = previousSidebarRenderSourcesRef.current;
  if (previousSidebarRenderSources) {
    let attributed = false;
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

  const {
    projectSections,
    groupSearchDataByGroup,
    sectionsForRender,
    searchMatchCount,
  } = useSessionSidebarSections({
    normalizedProjects: sortedProjects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject,
    projectRepoStatus,
    projectRootBranches,
    lastRepoStatus: lastRepoStatusRef.current,
    buildGroupedSessions,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    foldersMap,
  });

  const searchEmptyState = React.useMemo(() => (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noMatches.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noMatches.description')}</p>
    </div>
  ), [t]);

  const { getOrderedGroups } = useGroupOrdering(groupOrderByProject);
  const hasInitializedArchivedCollapseRef = React.useRef(false);

  React.useEffect(() => {
    if (hasInitializedArchivedCollapseRef.current || projectSections.length === 0) {
      return;
    }
    const archivedGroupKeys = projectSections.flatMap((section) =>
      section.groups
        .filter((group) => group.isArchivedBucket)
        .map((group) => `${section.project.id}:${group.id}`),
    );
    if (archivedGroupKeys.length > 0) {
      setCollapsedGroups((prev) => new Set([...prev, ...archivedGroupKeys]));
    }
    hasInitializedArchivedCollapseRef.current = true;
  }, [projectSections]);

  const sessionSidebarMetaById = React.useMemo(() => {
    const meta = new Map<string, {
      node: SessionNode;
      projectId: string | null;
      groupDirectory: string | null;
      secondaryMeta: {
        projectLabel?: string | null;
        branchLabel?: string | null;
      } | null;
    }>();
    const projectPathLengthBySessionId = new Map<string, number>();

    projectSections.forEach((section) => {
      const projectLabel = formatProjectLabel(
        section.project.label?.trim()
        || formatDirectoryName(section.project.normalizedPath, homeDirectory)
        || section.project.normalizedPath,
      );
      section.groups.forEach((group) => {
        const branchCandidate = group.branch && group.branch !== 'HEAD' && group.branch !== projectLabel
          ? group.branch
          : null;
        const secondaryMeta = { projectLabel, branchLabel: branchCandidate };

        const visit = (nodes: SessionNode[]) => {
          nodes.forEach((node) => {
            const nextProjectPathLength = section.project.normalizedPath.length;
            const currentProjectPathLength = projectPathLengthBySessionId.get(node.session.id) ?? -1;
            if (nextProjectPathLength < currentProjectPathLength) {
              return;
            }

            meta.set(node.session.id, {
              node,
              projectId: section.project.id,
              groupDirectory: group.directory,
              secondaryMeta,
            });
            projectPathLengthBySessionId.set(node.session.id, nextProjectPathLength);
            if (node.children.length > 0) {
              visit(node.children);
            }
          });
        };

        visit(group.sessions);
      });
    });

    return meta;
  }, [projectSections, homeDirectory]);

  const recentSessions = React.useMemo(() => {
    if (!showRecentSection || isVSCode) {
      return [];
    }

    return deriveRecentSessions(sessions, activeSessionIdSet)
      .sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks));
  }, [activeSessionIdSet, isVSCode, pinnedSessionIds, sessionOrderRanks, sessions, showRecentSection]);

  // Prefetch is wired below, after recentSessions is computed.

  const activitySections = React.useMemo(() => {
    // VS Code renders the full grouped project view (one group per open
    // workspace, folders + pinned native); the flat "recent" activity list is
    // web/desktop-only.
    if (isVSCode || !showRecentSection) {
      return [];
    }

    const toItem = (session: Session) => {
      const existing = sessionSidebarMetaById.get(session.id);
      const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      const node = existing?.node ?? { session, children: [], worktree: null };
      const filteredNodes = hasSessionSearchQuery
        ? filterSessionNodesForSearch([node], normalizedSessionSearchQuery)
        : [node];
      const filteredNode = filteredNodes[0];
      if (!filteredNode) {
        return null;
      }
      const secondaryMeta = existing?.secondaryMeta
        ? {
            projectLabel: existing.secondaryMeta.projectLabel,
            branchLabel: isVSCode ? null : existing.secondaryMeta.branchLabel,
          }
        : null;
      return {
        node: filteredNode,
        projectId: existing?.projectId ?? null,
        groupDirectory: existing?.groupDirectory ?? sessionDirectory,
        secondaryMeta,
      };
    };

    const items = recentSessions
      .map(toItem)
      .filter((item): item is NonNullable<ReturnType<typeof toItem>> => item !== null);

    return [
      { key: 'active-now' as const, title: t('sessions.sidebar.activity.recentTitle'), items },
    ];
  }, [filterSessionNodesForSearch, hasSessionSearchQuery, isVSCode, normalizedSessionSearchQuery, recentSessions, sessionSidebarMetaById, showRecentSection, t]);

  const hasActivitySectionItems = React.useMemo(
    () => activitySections.some((section) => section.items.length > 0),
    [activitySections],
  );


  const sectionsForSidebarRender = React.useMemo(() => {
    return showArchivedSessions
      ? sectionsForRender
      : sectionsForRender.map((section) => ({
        ...section,
        groups: section.groups.filter((group) => !group.isArchivedBucket),
      }));
  }, [sectionsForRender, showArchivedSessions]);

  const prLookup = React.useMemo(() => {
    if (!isVisible) {
      return {
        keys: EMPTY_STRING_ARRAY,
        displayKeyByLookupKey: new Map<string, string>(),
      };
    }
    const keys = new Set<string>();
    const displayKeyByLookupKey = new Map<string, string>();
    sectionsForSidebarRender.forEach((section) => {
      section.groups.forEach((group) => {
        const directory = normalizePath(group.directory ?? null);
        const branch = group.branch?.trim() || gitBranches.get(directory || '')?.trim();
        if (!directory || !branch) {
          return;
        }
        const lookupKey = getGitHubPrStatusKey(directory, branch);
        keys.add(lookupKey);
        displayKeyByLookupKey.set(lookupKey, `${directory}::${branch}`);
      });
    });
    return { keys: [...keys], displayKeyByLookupKey };
  }, [gitBranches, isVisible, sectionsForSidebarRender]);

  const prVisualSummaryMap = usePrVisualSummaryByKeys(prLookup.keys);

  React.useEffect(() => {
    if (!isVisible || !githubAuthChecked || !githubAuthStatus?.connected || !github) {
      return;
    }

    const targetsByKey = new Map<string, { directory: string; branch: string }>();
    const now = Date.now();

    sectionsForSidebarRender.forEach((section) => {
      if (collapsedProjects.has(section.project.id)) {
        return;
      }

      section.groups.forEach((group) => {
        const directory = normalizePath(group.directory ?? null);
        const branch = group.branch?.trim() || gitBranches.get(directory || '')?.trim();
        if (!directory || !branch) {
          return;
        }
        const key = getGitHubPrStatusKey(directory, branch);
        const entry = useGitHubPrStatusStore.getState().entries[key];
        const hasPr = Boolean(entry?.status?.pr);
        const retryKey = `${directory}::${branch}`;
        const noPrLastCheckedAt = Math.max(entry?.lastRefreshAt ?? 0, entry?.lastDiscoveryPollAt ?? 0);
        const shouldRetryNoPr = Boolean(
          entry?.isInitialStatusResolved
          && !hasPr
          && (
            !retriedNoPrStatusKeysRef.current.has(retryKey)
            || now - noPrLastCheckedAt >= SIDEBAR_PR_NO_PR_RETRY_MS
          ),
        );

        if (!entry || !entry.isInitialStatusResolved || shouldRetryNoPr) {
          if (shouldRetryNoPr) {
            retriedNoPrStatusKeysRef.current.add(retryKey);
          }
          if (!targetsByKey.has(key)) {
            targetsByKey.set(key, { directory, branch });
          }
        }
      });
    });

    if (targetsByKey.size === 0) {
      return;
    }

    targetsByKey.forEach((target, key) => {
      ensurePrStatusEntry(key);
      setPrStatusParams(key, {
        directory: target.directory,
        branch: target.branch,
        remoteName: null,
        canShow: true,
        github,
        githubAuthChecked,
        githubConnected: githubAuthStatus.connected,
      });
    });

    void refreshPrStatusTargets([...targetsByKey.values()], {
      silent: true,
      markInitialResolved: true,
    });
  }, [
    collapsedProjects,
    ensurePrStatusEntry,
    github,
    githubAuthChecked,
    githubAuthStatus?.connected,
    isVisible,
    gitBranches,
    refreshPrStatusTargets,
    sectionsForSidebarRender,
    setPrStatusParams,
  ]);

  const desktopHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const mobileHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const headerActionButtonClass = mobileVariant ? mobileHeaderActionButtonClass : desktopHeaderActionButtonClass;
  const headerActionIconClass = 'h-4.5 w-4.5';
  const stuckProjectHeaders = useStickyProjectHeaders({
    enabled: isVisible,
    isDesktopShellRuntime,
    projectSections,
    projectHeaderSentinelRefs,
  });

  const renderSessionNode = useStableRenderCallback(
    (
      node: SessionNode,
      depth: number = 0,
      groupDirectory?: string | null,
      projectId?: string | null,
      archivedBucket: boolean = false,
      secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
      renderContext: 'project' | 'recent' = 'project',
      renderExtras?: SessionNodeRenderExtras,
    ): React.ReactNode => (
      <SessionNodeItem
        node={node}
        depth={depth}
        groupDirectory={groupDirectory}
        projectId={projectId}
        archivedBucket={archivedBucket}
        pinnedSessionIds={pinnedSessionIds}
        expandedParents={renderContext === 'recent' ? recentExpandedParents : projectExpandedParents}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        notifyOnSubtasks={notifyOnSubtasks}
        editingId={editingId}
        setEditingId={setEditingId}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        handleSaveEdit={stableHandleSaveEdit}
        handleCancelEdit={stableHandleCancelEdit}
        toggleParent={toggleParent}
        handleSessionSelect={stableHandleSessionSelect}
        handleSessionDoubleClick={stableHandleSessionDoubleClick}
        togglePinnedSession={togglePinnedSession}
        handleShareSession={stableHandleShareSession}
        copiedSessionId={copiedSessionId}
        handleCopyShareUrl={stableHandleCopyShareUrl}
        handleUnshareSession={stableHandleUnshareSession}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        renamingFolderId={renamingFolderId}
        getFoldersForScope={getFoldersForScope}
        getSessionFolderId={getSessionFolderId}
        removeSessionFromFolder={removeSessionFromFolder}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={stableCreateFolderAndStartRename}
        openContextPanelTab={openContextPanelTab}
        handleDeleteSession={stableHandleDeleteSession}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        renderSessionNode={renderSessionNode}
        secondaryMeta={secondaryMeta}
        renderContext={renderContext}
        subtreeContainsEditing={renderExtras?.subtreeContainsEditing ?? EMPTY_SUBTREE_SET}
        menuOpenSessionId={renderExtras?.menuOpenSessionId ?? null}
        nodeStructureKey={renderExtras?.nodeStructureKey ?? ''}
        childRenderExtrasFor={renderExtras?.childRenderExtrasFor}
      />
    ),
  );

  const toggleCollapsedGroup = React.useCallback((key: string) => {
    resetGroupSessionLimit(key);
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [resetGroupSessionLimit]);

  const prVisualStateByDirectoryBranch = React.useMemo(() => {
    const result = new Map<string, PrIndicator>();
    for (const [key, summary] of prVisualSummaryMap) {
      const displayKey = prLookup.displayKeyByLookupKey.get(key);
      if (!displayKey) {
        continue;
      }
      result.set(displayKey, {
        visualState: summary.visualState as PrVisualState,
        number: summary.number,
        url: summary.url,
        state: summary.prState as 'open' | 'closed' | 'merged',
        draft: summary.draft,
        title: summary.title,
        base: summary.base,
        head: summary.head,
        checks: summary.checks as PrIndicator['checks'],
        canMerge: summary.canMerge,
        mergeableState: summary.mergeableState,
        repo: summary.repo,
      });
    }
    return result;
  }, [prLookup.displayKeyByLookupKey, prVisualSummaryMap]);

  const renderGroupSessions = React.useCallback(
    (
      group: SessionGroup,
      groupKey: string,
      projectId?: string | null,
      hideGroupLabel?: boolean,
      dragHandleProps?: SortableDragHandleProps | null,
      compactBodyPadding?: boolean,
      scrollContainerRef?: React.RefObject<HTMLElement | null>,
    ) => (
      <SessionGroupSection
        group={group}
        groupKey={groupKey}
        projectId={projectId}
        hideGroupLabel={hideGroupLabel}
        compactBodyPadding={compactBodyPadding}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        groupSearchDataByGroup={groupSearchDataByGroup}
        visibleSessionCount={visibleSessionCountByGroup.get(groupKey)}
        collapsedGroups={collapsedGroups}
        hideDirectoryControls={hideDirectoryControls}
        collapsedFolderIds={collapsedFolderIds}
        toggleFolderCollapse={toggleFolderCollapse}
        renameFolder={renameFolder}
        deleteFolder={deleteFolder}
        showDeletionDialog={showDeletionDialog}
        setDeleteFolderConfirm={setDeleteFolderConfirm}
        renderSessionNode={renderSessionNode}
        projectRepoStatus={projectRepoStatus}
        lastRepoStatus={lastRepoStatusRef.current}
        showMoreGroupSessions={showMoreGroupSessions}
        resetGroupSessionLimit={resetGroupSessionLimit}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        activeProjectId={activeProjectId}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraftFromTree}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={stableCreateFolderAndStartRename}
        renamingFolderId={renamingFolderId}
        renameFolderDraft={renameFolderDraft}
        setRenameFolderDraft={setRenameFolderDraft}
        setRenamingFolderId={setRenamingFolderId}
        pinnedSessionIds={pinnedSessionIds}
        expandedParents={projectExpandedParents}
        sessionOrderIndex={sessionOrderIndex}
        editingId={editingId}
        editTitle={editTitle}
        openSidebarMenuKey={openSidebarMenuKey}
        prVisualStateByDirectoryBranch={prVisualStateByDirectoryBranch}
        activeActivitySessionIds={activeActivitySessionIds}
        unreadActivitySessionIds={unreadActivitySessionIds}
        notifyOnSubtasks={notifyOnSubtasks}
        onToggleCollapsedGroup={toggleCollapsedGroup}
        dragHandleProps={dragHandleProps}
        scrollContainerRef={scrollContainerRef}
      />
    ),
    [
      hasSessionSearchQuery,
      normalizedSessionSearchQuery,
      groupSearchDataByGroup,
      visibleSessionCountByGroup,
      collapsedGroups,
      hideDirectoryControls,
      collapsedFolderIds,
      toggleFolderCollapse,
      renameFolder,
      deleteFolder,
      showDeletionDialog,
      renderSessionNode,
      projectRepoStatus,
      showMoreGroupSessions,
      resetGroupSessionLimit,
      mobileVariant,
      alwaysShowSidebarActions,
      activeProjectId,
      setActiveProjectIdOnly,
      setActiveMainTab,
      setSessionSwitcherOpen,
      openNewSessionDraftFromTree,
      addSessionToFolder,
      stableCreateFolderAndStartRename,
      renamingFolderId,
      renameFolderDraft,
      pinnedSessionIds,
      projectExpandedParents,
      sessionOrderIndex,
      editingId,
      editTitle,
      openSidebarMenuKey,
      prVisualStateByDirectoryBranch,
      activeActivitySessionIds,
      unreadActivitySessionIds,
      notifyOnSubtasks,
      toggleCollapsedGroup,
    ],
  );

  const topContent = React.useMemo(
    () => (!isVSCode && showRecentSection && !hasSessionSearchQuery) ? (
      <SidebarActivitySections
        sections={activitySections}
        renderSessionNode={renderSessionNode}
        editingId={editingId}
        openSidebarMenuKey={openSidebarMenuKey}
        expansionState={recentExpandedParents}
        variant="section"
      />
    ) : null,
    [activitySections, editingId, hasSessionSearchQuery, isVSCode, openSidebarMenuKey, recentExpandedParents, renderSessionNode, showRecentSection],
  );
  const isInlineEditing = Boolean(renamingFolderId || editingId || editingProjectDialogId);

  const {
    selectionModeEnabled,
    hasSelection,
    selectedIdsSize,
    bulkScopeIsArchived,
    derivedSelectionScope,
    bulkScopeFolders,
    bulkCanRemoveFromFolder,
    handleToggleSelectionMode,
    handleExitSelectionMode,
    handleBulkMoveToFolder,
    handleBulkCreateFolderAndMove,
    handleBulkRemoveFromFolder,
    handleBulkDelete,
    confirmBulkDelete,
  } = useSidebarBulkActions({
    isInlineEditing,
    showDeletionDialog,
    foldersMap,
    addSessionsToFolder,
    removeSessionsFromFolders,
    createFolderAndStartRename,
    archiveSessions,
    deleteSessions,
    setBulkDeleteConfirm,
  });
  const handleOpenMultiRunFromHeader = React.useCallback(() => {
    setActiveMainTab('chat');
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openMultiRunLauncher();
  }, [mobileVariant, openMultiRunLauncher, setActiveMainTab, setSessionSwitcherOpen]);

  const handleOpenNewSessionDraftFromHeader = React.useCallback(() => {
    setActiveMainTab('chat');
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openNewSessionDraft();
  }, [mobileVariant, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

  return (
    <div
      ref={sessionSearchContainerRef}
      className={cn(
        'relative flex h-full flex-col text-foreground overflow-x-hidden',
        mobileVariant ? '' : 'bg-transparent',
      )}
    >
      <SidebarBootstrapDemandEffect
        owner={bootstrapDemandOwner}
        childStores={childStores}
        projectSections={projectSections}
        activeProjectId={activeProjectId}
        collapsedProjects={collapsedProjects}
        collapsedGroups={collapsedGroups}
        currentDirectory={currentDirectory}
      />
      <ProjectSessionSelectionEffect
        projectSections={projectSections}
        activeProjectId={activeProjectId}
        initialActiveSessionByProject={initialActiveSessionByProject}
        persistActiveSessionByProject={persistActiveSessionByProject}
        handleSessionSelect={stableHandleSessionSelect}
        mobileVariant={mobileVariant}
        openNewSessionDraft={openNewSessionDraft}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
      />
      <SessionPrefetchEffect
        enabled={isVisible}
        sortedSessions={orderedSessions}
        recentSessions={recentSessions}
        prefetchSession={sync.prefetchSession}
      />
      <SidebarHeader
        hideDirectoryControls={hideDirectoryControls}
        showRecentControls={!isVSCode}
        handleOpenDirectoryDialog={handleOpenDirectoryDialog}
        openNewSessionDraft={handleOpenNewSessionDraftFromHeader}
        canOpenMultiRun={projects.length > 0}
        openMultiRunLauncher={handleOpenMultiRunFromHeader}
        headerActionIconClass={headerActionIconClass}
        headerActionButtonClass={headerActionButtonClass}
        isSessionSearchOpen={isSessionSearchOpen}
        setIsSessionSearchOpen={setIsSessionSearchOpen}
        sessionSearchInputRef={sessionSearchInputRef}
        sessionSearchQuery={sessionSearchQuery}
        setSessionSearchQuery={setSessionSearchQuery}
        hasSessionSearchQuery={hasSessionSearchQuery}
        searchMatchCount={searchMatchCount}
        collapseAllProjects={collapseAllProjects}
        expandAllProjects={expandAllProjects}
        openScheduledTasksDialog={() => setScheduledTasksDialogOpen(true)}
        selectionModeEnabled={selectionModeEnabled}
        onToggleSelectionMode={handleToggleSelectionMode}
      />

      {isVisible ? <SidebarProjectsList
        topContent={topContent}
        hasSharedSessions={hasActivitySectionItems}
        sectionsForRender={sectionsForSidebarRender}
        projectSections={projectSections}
        activeProjectId={activeProjectId}
        showOnlyMainWorkspace={showOnlyMainWorkspace}
        hasSessionSearchQuery={hasSessionSearchQuery}
        emptyState={emptyState}
        searchEmptyState={searchEmptyState}
        renderGroupSessions={renderGroupSessions}
        homeDirectory={homeDirectory}
        collapsedProjects={collapsedProjects}
        hideDirectoryControls={hideDirectoryControls}
        projectRepoStatus={projectRepoStatus}
        isDesktopShellRuntime={isDesktopShellRuntime}
        stuckProjectHeaders={stuckProjectHeaders}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        toggleProject={toggleProject}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraftFromTree}
        openNewWorktreeDialog={openNewWorktreeDialog}
        openProjectEditDialog={setEditingProjectDialogId}
        removeProject={removeProject}
        projectHeaderSentinelRefs={projectHeaderSentinelRefs}
        reorderProjects={reorderProjects}
        projectSortOrder={projectSortOrder}
        getOrderedGroups={getOrderedGroups}
        setGroupOrderByProject={setGroupOrderByProject}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        isInlineEditing={isInlineEditing}
        activeActivitySessionIds={activeActivitySessionIds}
        unreadActivitySessionIds={unreadActivitySessionIds}
        notifyOnSubtasks={notifyOnSubtasks}
      /> : null}

      {selectionModeEnabled && hasSelection ? (
        <BulkActionBar
          selectedCount={selectedIdsSize}
          scopeKey={derivedSelectionScope}
          scopeFolders={bulkScopeFolders}
          archivedBucket={bulkScopeIsArchived}
          onMoveToFolder={handleBulkMoveToFolder}
          onCreateFolderAndMove={handleBulkCreateFolderAndMove}
          onRemoveFromFolder={handleBulkRemoveFromFolder}
          canRemoveFromFolder={bulkCanRemoveFromFolder}
          onDelete={handleBulkDelete}
          onDone={handleExitSelectionMode}
        />
      ) : null}

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
          setActiveMainTab('chat');
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

      <ScheduledTasksDialog />

      <SessionDeleteConfirmDialog
        value={deleteSessionConfirm}
        setValue={setDeleteSessionConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        onConfirm={confirmDeleteSession}
      />

      <FolderDeleteConfirmDialog
        value={deleteFolderConfirm}
        setValue={setDeleteFolderConfirm}
        onConfirm={confirmDeleteFolder}
      />

      <BulkSessionDeleteConfirmDialog
        value={bulkDeleteConfirm}
        setValue={setBulkDeleteConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        onConfirm={confirmBulkDelete}
      />
    </div>
  );
};

export const SessionSidebar = React.memo(SessionSidebarComponent);
