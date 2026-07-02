import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { formatDirectoryName, cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSync } from '@/sync/use-sync';
import { useSessionPrefetch } from './sidebar/hooks/useSessionPrefetch';
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
import { useProjectSessionSelection } from './sidebar/hooks/useProjectSessionSelection';
import { useGroupOrdering } from './sidebar/hooks/useGroupOrdering';
import { useSessionGrouping } from './sidebar/hooks/useSessionGrouping';
import { useSessionSearchEffects } from './sidebar/hooks/useSessionSearchEffects';
import { useSessionActions } from './sidebar/hooks/useSessionActions';
import { useSidebarPersistence } from './sidebar/hooks/useSidebarPersistence';
import { useProjectRepoStatus } from './sidebar/hooks/useProjectRepoStatus';
import { useProjectSessionLists } from './sidebar/hooks/useProjectSessionLists';
import { useSessionFolderCleanup } from './sidebar/hooks/useSessionFolderCleanup';
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
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
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
import { type SessionGroup, type SessionNode } from './sidebar/types';
import {
  deriveRecentSessions,
} from './sidebar/activitySections';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import {
  compareSessionsByPinnedAndTime,
  formatProjectLabel,
  normalizePath,
} from './sidebar/utils';
import {
  mergeLiveSessionWithGlobalSession,
  refreshGlobalSessions,
  refreshGlobalSessionsForDirectories,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_ORDER_STORAGE_KEY = 'oc.sessions.groupOrder';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
// v2 key holds composite "${renderContext}:${active|archived}:${sessionId}"
// entries so the same session in different render contexts (e.g. "Recent"
// and a project's root) has independent expand state. v1 held bare session
// ids; useSidebarPersistence migrates v1 data on first read by fanning each
// id into all four context combinations.
const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents.v2';
const LEGACY_SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents';
const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

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

const useStableRenderCallback = <Args extends unknown[], Return>(handler: (...args: Args) => Return): ((...args: Args) => Return) => {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  return React.useCallback((...args: Args) => handlerRef.current(...args), []);
};

interface SessionSidebarProps {
  mobileVariant?: boolean;
  onSessionSelected?: (sessionId: string) => void;
  allowReselect?: boolean;
  hideDirectoryControls?: boolean;
  showOnlyMainWorkspace?: boolean;
}

export const SessionSidebar: React.FC<SessionSidebarProps> = ({
  mobileVariant = false,
  onSessionSelected,
  allowReselect = false,
  hideDirectoryControls = false,
  showOnlyMainWorkspace = false,
}) => {
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
  const setPinnedSessionIds = useSessionPinnedStore((state) => state.setIds);
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
  const [activeSessionByProject, setActiveSessionByProject] = React.useState<Map<string, string>>(() => {
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
  });

  const [projectRootBranches, setProjectRootBranches] = React.useState<Map<string, string>>(new Map());
  const projectHeaderSentinelRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());
  const ignoreIntersectionUntil = React.useRef<number>(0);

  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);

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
  const cleanupSessions = useSessionFoldersStore((state) => state.cleanupSessions);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);

  useSessionSearchEffects({
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchContainerRef,
  });

  const gitBranches = useGitAllBranches();

  const sync = useSync();
  const liveSessions = useAllLiveSessions();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const hasLoadedGlobalSessions = useGlobalSessionsStore((state) => state.hasLoaded);
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
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
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const merged = globalActiveSessions.map((session) => {
      const liveSession = liveById.get(session.id);
      return liveSession ? mergeLiveSessionWithGlobalSession(liveSession, session) : session;
    });
    const seenIds = new Set(merged.map((session) => session.id));

    liveSessions.forEach((session) => {
      if (seenIds.has(session.id)) {
        return;
      }
      merged.push(session);
    });

    return merged.filter((session) => isKnownActiveSessionDirectory(session, knownSessionDirectories, {
      allowUnknownDirectory: !isVSCode,
      allowEmptyDirectorySet: !isVSCode,
    }));
  }, [globalActiveSessions, isVSCode, knownSessionDirectories, liveSessions]);

  const syncSessionStructureSignature = React.useMemo(
    () => liveSessions
      .map((session) => {
        const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null) ?? '';
        return `${session.id}:${session.title ?? ''}:${session.time?.archived ? 1 : 0}:${directory}`;
      })
      .join('|'),
    [liveSessions],
  );

  const syncSessionsSnapshotRef = React.useRef<Session[]>(liveSessions);
  React.useEffect(() => {
    syncSessionsSnapshotRef.current = liveSessions;
  }, [syncSessionStructureSignature, liveSessions]);

  // Batched live-session index. Building this here turns the per-row
  // `useSession(session.id)` reads in SessionNodeItem (each of which
  // iterates all child-stores via `findLiveSession`) into a single
  // Map lookup. With M visible rows, that changes an O(M × child-stores)
  // work to O(child-stores) once per Sidebar render.
  const liveSessionById = React.useMemo(
    () => new Map(liveSessions.map((session) => [session.id, session] as const)),
    [liveSessions],
  );

  const projectWorktreeDiscoveryKey = React.useMemo(
    () => projects
      .map((project) => `${project.id}:${normalizePath(project.path) ?? ''}`)
      .join('|'),
    [projects],
  );

  const initialGlobalSessionsRefreshStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (initialGlobalSessionsRefreshStartedRef.current) {
      return;
    }
    initialGlobalSessionsRefreshStartedRef.current = true;
    void refreshGlobalSessions(syncSessionsSnapshotRef.current);
  }, []);

  // Re-discover worktrees when the project set changes or when an external
  // mutation (create/attach/remove) bumps the epoch. The epoch replaces the
  // old discoveredProjectsRef guard — the effect re-runs whenever the epoch
  // changes, regardless of whether the project set changed.
  const worktreeDiscoveryEpoch = useSessionUIStore((state) => state.worktreeDiscoveryEpoch);
  React.useEffect(() => {
    let cancelled = false;

    const discoverWorktrees = async () => {
      const projectEntries = useProjectsStore.getState().projects;
      if (projectEntries.length === 0) return;

      const worktreesByProject = new Map<string, WorktreeMetadata[]>();
      // Track which project paths were confirmed as non-Git repos so we can
      // prune their stale entries. Projects where discovery failed (server
      // not ready) are NOT added here — their data is preserved.
      const nonGitProjectPaths = new Set<string>();

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
              nonGitProjectPaths.add(projectPath);
              continue;
            }
            const worktrees = await listProjectWorktrees({ id: project.id, path: projectPath });
            if (cancelled) continue;
            // Always add the project to the map, even with an empty worktree
            // list. Skipping projects with zero worktrees would wipe persisted
            // data for those projects when the store is overwritten below.
            worktreesByProject.set(projectPath, worktrees);
          } catch {
            // ignore discovery errors — the merge below preserves existing
            // data for projects where discovery failed
          }
        }
      });
      await Promise.all(workers);

      if (cancelled) return;

      // Merge discovery results with existing store data. This preserves
      // worktrees for projects where discovery failed (e.g., server not
      // ready at startup) while updating projects where discovery succeeded.
      // Prune stale entries for projects removed from the list or confirmed
      // as non-Git repos.
      const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
      const mergedByProject = new Map<string, WorktreeMetadata[]>();
      const currentProjectPaths = new Set(
        projectEntries
          .map((p) => normalizePath(p.path))
          .filter((p): p is string => p !== null),
      );
      for (const [projectPath, worktrees] of worktreesByProject) {
        mergedByProject.set(projectPath, worktrees);
      }
      // Preserve existing data for projects in the current project list
      // where discovery failed, but drop entries for removed projects
      // and projects confirmed as non-Git repos.
      for (const [projectPath, worktrees] of currentByProject) {
        if (!mergedByProject.has(projectPath) && currentProjectPaths.has(projectPath) && !nonGitProjectPaths.has(projectPath)) {
          mergedByProject.set(projectPath, worktrees);
        }
      }

      useSessionUIStore.setState({
        availableWorktrees: [...mergedByProject.values()].flat(),
        availableWorktreesByProject: mergedByProject,
      });
    };

    void discoverWorktrees();

    return () => {
      cancelled = true;
    };
  }, [projectWorktreeDiscoveryKey, worktreeDiscoveryEpoch]);

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
    gitBranches,
    isVSCode,
  });

  const { scheduleCollapsedProjectsPersist } = useSidebarPersistence({
    isVSCode,
    hasLoadedGlobalSessions,
    safeStorage,
    keys: {
      sessionExpanded: SESSION_EXPANDED_STORAGE_KEY,
      sessionExpandedLegacy: LEGACY_SESSION_EXPANDED_STORAGE_KEY,
      projectCollapse: PROJECT_COLLAPSE_STORAGE_KEY,
      sessionPinned: SESSION_PINNED_STORAGE_KEY,
      groupOrder: GROUP_ORDER_STORAGE_KEY,
      projectActiveSession: PROJECT_ACTIVE_SESSION_STORAGE_KEY,
      groupCollapse: GROUP_COLLAPSE_STORAGE_KEY,
    },
    sessions,
    pinnedSessionIds,
    setPinnedSessionIds,
    groupOrderByProject,
    activeSessionByProject,
    collapsedGroups,
    setExpandedParents,
    setCollapsedProjects,
  });

  const sortedSessions = React.useMemo(() => {
    return [...sessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));
  }, [sessions, pinnedSessionIds]);

  // Stable signature: id + updatedAt joined. When this string is
  // unchanged, the relative ordering of sessions is identical and the
  // derived `sessionOrderIndex` Map can return the previous reference.
  // Without this, a fresh `sortedSessions` array (cheap to rebuild) would
  // still hand a new Map identity to the entire SessionGroupSection
  // memo chain, invalidating sourceGroupNodes, nodeBySessionId, and the
  // rest of the down-stream useMemo chain.
  const sessionOrderSignature = React.useMemo(
    () => sortedSessions.map((s) => `${s.id}:${s.time?.updated ?? 0}`).join('|'),
    [sortedSessions],
  );

  const sessionOrderIndexRef = React.useRef<{ signature: string; map: Map<string, number> } | null>(null);
  const sessionOrderIndex = React.useMemo(() => {
    const cached = sessionOrderIndexRef.current;
    if (cached && cached.signature === sessionOrderSignature) {
      return cached.map;
    }
    const next = new Map(sortedSessions.map((session, index) => [session.id, index]));
    sessionOrderIndexRef.current = { signature: sessionOrderSignature, map: next };
    return next;
  }, [sessionOrderSignature, sortedSessions]);

  const childrenMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    sortedSessions.forEach((session) => {
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) {
        return;
      }
      const collection = map.get(parentID) ?? [];
      collection.push(session);
      map.set(parentID, collection);
    });
    map.forEach((list) => list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds)));
    return map;
  }, [sortedSessions, pinnedSessionIds]);

  const emptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noSessions.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noSessions.description')}</p>
    </div>
  );

  const editingProject = React.useMemo(
    () => projects.find((project) => project.id === editingProjectDialogId) ?? null,
    [projects, editingProjectDialogId],
  );

  const handleSaveProjectEdit = React.useCallback((data: { label: string; icon: string | null; color: string | null; iconBackground: string | null }) => {
    if (!editingProjectDialogId) {
      return;
    }
    updateProjectMeta(editingProjectDialogId, data);
    setEditingProjectDialogId(null);
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
    activeProjectId,
    currentDirectory,
    currentSessionId,
    mobileVariant,
    allowReselect,
    onSessionSelected,
    isSessionSearchOpen,
    sessionSearchQuery,
    setSessionSearchQuery,
    setIsSessionSearchOpen,
    setActiveProjectIdOnly,
    setDirectory,
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

  // Auto-expand parent session when navigating to a subagent (child) session.
  // We don't know which render context the user will look at the parent in
  // (Recent, project root, archived bucket, ...), so fan out across all
  // four combinations to ensure it's expanded wherever it appears.
  React.useEffect(() => {
    if (!currentSessionId) return;
    const current = sessions.find((s) => s.id === currentSessionId);
    const parentID = (current as Session & { parentID?: string | null })?.parentID;
    if (!parentID) return;
    const keysToAdd = [
      `project:active:${parentID}`,
      `project:archived:${parentID}`,
      `recent:active:${parentID}`,
      `recent:archived:${parentID}`,
    ];
    setExpandedParents((prev) => {
      if (keysToAdd.every((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      keysToAdd.forEach((k) => next.add(k));
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [currentSessionId, sessions, safeStorage]);

  const toggleParent = React.useCallback((expansionKey: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(expansionKey)) {
        next.delete(expansionKey);
      } else {
        next.add(expansionKey);
      }
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
      }>;
  }, [projects]);

  const normalizedProjectPaths = React.useMemo(
    () => normalizedProjects.map((project) => project.normalizedPath),
    [normalizedProjects],
  );

  const projectSessionDirectories = React.useMemo(() => {
    const directories = new Set<string>();
    normalizedProjects.forEach((project) => {
      if (project.normalizedPath) directories.add(project.normalizedPath);
      if (isVSCode) {
        return;
      }
      const worktrees = availableWorktreesByProject.get(project.normalizedPath) ?? [];
      worktrees.forEach((worktree) => {
        const directory = normalizePath(worktree.path);
        if (directory) directories.add(directory);
      });
    });
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
  const gitRepoStatus = useGitRepoStatusMap(normalizedProjectPaths);
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshPrStatusTargets = useGitHubPrStatusStore((state) => state.refreshTargets);

  useProjectRepoStatus({
    normalizedProjects,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  });

  const isSessionsLoading = useSessionUIStore((state) => state.isLoading);
  useSessionFolderCleanup({
    isSessionsLoading,
    hasLoadedGlobalSessions,
    sessions,
    archivedSessions,
    normalizedProjects,
    isVSCode,
    availableWorktreesByProject,
    cleanupSessions,
  });

  const { getSessionsForProject, getArchivedSessionsForProject } = useProjectSessionLists({
    isVSCode,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
    normalizedProjects,
  });

  useArchivedAutoFolders({
    normalizedProjects,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
    isVSCode,
    isSessionsLoading,
    foldersMap,
    createFolder,
    addSessionToFolder,
    cleanupSessions,
  });

  // Keep last-known repo status to avoid UI jiggling during project switch
  const lastRepoStatusRef = React.useRef(false);
  if (activeProjectId && projectRepoStatus.has(activeProjectId)) {
    lastRepoStatusRef.current = Boolean(projectRepoStatus.get(activeProjectId));
  }

  const {
    projectSections,
    groupSearchDataByGroup,
    sectionsForRender,
    searchMatchCount,
  } = useSessionSidebarSections({
    normalizedProjects,
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

  const searchEmptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noMatches.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noMatches.description')}</p>
    </div>
  );

  useProjectSessionSelection({
    projectSections,
    activeProjectId,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    setActiveMainTab,
    setSessionSwitcherOpen,
  });

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

  const showRecentSection = useSessionDisplayStore((state) => state.showRecentSection);
  const showArchivedSessions = useSessionDisplayStore((state) => state.showArchivedSessions);

  const activeNowSessions = React.useMemo(() => {
    if (!showRecentSection || isVSCode) {
      return [];
    }

    return deriveRecentSessions(sessions)
      .sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));
  }, [isVSCode, pinnedSessionIds, sessions, showRecentSection]);

  // Prefetch is wired below, after recentSessionIds is computed.

  const activitySections = React.useMemo(() => {
    // VS Code renders the full grouped project view (one group per open
    // workspace, folders + pinned native); the flat "recent" activity list is
    // web/desktop-only.
    if (isVSCode || !showRecentSection) {
      return [];
    }

    const recentSessions = activeNowSessions;

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
  }, [activeNowSessions, filterSessionNodesForSearch, hasSessionSearchQuery, isVSCode, normalizedSessionSearchQuery, sessionSidebarMetaById, showRecentSection, t]);

  const hasActivitySectionItems = React.useMemo(
    () => activitySections.some((section) => section.items.length > 0),
    [activitySections],
  );


  const recentSessionIds = React.useMemo(() => {
    return new Set(activeNowSessions.map((session) => session.id));
  }, [activeNowSessions]);

  const recentSessionIdsList = React.useMemo(() => [...recentSessionIds], [recentSessionIds]);

  useSessionPrefetch({
    currentSessionId,
    sortedSessions,
    recentSessionIds: recentSessionIdsList,
    ensureSessionRenderable: sync.ensureSessionRenderable,
  });

  const sectionsForSidebarRender = React.useMemo(() => {
    return showArchivedSessions
      ? sectionsForRender
      : sectionsForRender.map((section) => ({
        ...section,
        groups: section.groups.filter((group) => !group.isArchivedBucket),
      }));
  }, [sectionsForRender, showArchivedSessions]);

  const prLookupKeys = React.useMemo(() => {
    const keys = new Set<string>();
    sectionsForSidebarRender.forEach((section) => {
      section.groups.forEach((group) => {
        const directory = normalizePath(group.directory ?? null);
        const branch = group.branch?.trim() || gitBranches.get(directory || '')?.trim();
        if (!directory || !branch) {
          return;
        }
        keys.add(getGitHubPrStatusKey(directory, branch));
      });
    });
    return [...keys];
  }, [gitBranches, sectionsForSidebarRender]);

  const prVisualSummaryMap = usePrVisualSummaryByKeys(prLookupKeys);

  React.useEffect(() => {
    if (!githubAuthChecked || !githubAuthStatus?.connected || !github) {
      return;
    }

    const missingTargets: Array<{ directory: string; branch: string; remoteName?: string | null }> = [];
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
          missingTargets.push({ directory, branch });
        }
      });
    });

    if (missingTargets.length === 0) {
      return;
    }

    const uniqueTargets = new Map<string, { directory: string; branch: string; remoteName?: string | null }>();
    missingTargets.forEach((target) => {
      const key = getGitHubPrStatusKey(target.directory, target.branch, target.remoteName ?? null);
      if (!uniqueTargets.has(key)) {
        uniqueTargets.set(key, target);
      }
    });

    uniqueTargets.forEach((target, key) => {
      ensurePrStatusEntry(key);
      setPrStatusParams(key, {
        directory: target.directory,
        branch: target.branch,
        remoteName: target.remoteName ?? null,
        canShow: true,
        github,
        githubAuthChecked,
        githubConnected: githubAuthStatus.connected,
      });
    });

    void refreshPrStatusTargets([...uniqueTargets.values()], {
      silent: true,
      markInitialResolved: true,
    });
  }, [
    collapsedProjects,
    ensurePrStatusEntry,
    github,
    githubAuthChecked,
    githubAuthStatus?.connected,
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
        currentSessionId={currentSessionId}
        pinnedSessionIds={pinnedSessionIds}
        expandedParents={expandedParents}
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
        subtreeContainsActive={renderExtras?.subtreeContainsActive ?? EMPTY_SUBTREE_SET}
        subtreeContainsEditing={renderExtras?.subtreeContainsEditing ?? EMPTY_SUBTREE_SET}
        menuOpenSessionId={renderExtras?.menuOpenSessionId ?? null}
        nodeStructureKey={renderExtras?.nodeStructureKey ?? ''}
        childRenderExtrasFor={renderExtras?.childRenderExtrasFor}
        liveSessionById={liveSessionById}
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
      result.set(key, {
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
  }, [prVisualSummaryMap]);

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
        expandedParents={expandedParents}
        sessionOrderIndex={sessionOrderIndex}
        currentSessionId={currentSessionId}
        editingId={editingId}
        editTitle={editTitle}
        openSidebarMenuKey={openSidebarMenuKey}
        liveSessionById={liveSessionById}
        prVisualStateByDirectoryBranch={prVisualStateByDirectoryBranch}
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
      expandedParents,
      sessionOrderIndex,
      currentSessionId,
      editingId,
      editTitle,
      openSidebarMenuKey,
      liveSessionById,
      prVisualStateByDirectoryBranch,
      toggleCollapsedGroup,
    ],
  );

  const topContent = (!isVSCode && showRecentSection && !hasSessionSearchQuery) ? (
    <SidebarActivitySections
      sections={activitySections}
      renderSessionNode={renderSessionNode}
      currentSessionId={currentSessionId}
      editingId={editingId}
      openSidebarMenuKey={openSidebarMenuKey}
      variant="section"
    />
  ) : null;
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

      <SidebarProjectsList
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
        getOrderedGroups={getOrderedGroups}
        setGroupOrderByProject={setGroupOrderByProject}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        isInlineEditing={isInlineEditing}
      />

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

      {editingProject ? (
        <ProjectEditDialog
          open={Boolean(editingProject)}
          onOpenChange={(open) => {
            if (!open) {
              setEditingProjectDialogId(null);
            }
          }}
          projectId={editingProject.id}
          projectName={editingProject.label || formatDirectoryName(editingProject.path, homeDirectory)}
          projectPath={editingProject.path}
          initialIcon={editingProject.icon}
          initialColor={editingProject.color}
          initialIconBackground={editingProject.iconBackground}
          onSave={handleSaveProjectEdit}
        />
      ) : null}

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
