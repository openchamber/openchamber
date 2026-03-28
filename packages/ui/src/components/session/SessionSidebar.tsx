import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { RiLayoutLeftLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';
import { isDesktopLocalOriginActive, isDesktopShell, isTauriShell } from '@/lib/desktop';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { sessionEvents } from '@/lib/sessionEvents';
import { formatDirectoryName, cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/useSessionStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { GitHubPullRequestStatus } from '@/lib/api/types';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useGitStore } from '@/stores/useGitStore';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { ProjectNotesTodoPanel } from './ProjectNotesTodoPanel';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useArchivedAutoFolders } from './sidebar/hooks/useArchivedAutoFolders';
import { useSessionSidebarSections } from './sidebar/hooks/useSessionSidebarSections';
import { useProjectSessionSelection } from './sidebar/hooks/useProjectSessionSelection';
import { useGroupOrdering } from './sidebar/hooks/useGroupOrdering';
import { useSessionGrouping } from './sidebar/hooks/useSessionGrouping';
import { useSessionSearchEffects } from './sidebar/hooks/useSessionSearchEffects';
import { useSessionPrefetch } from './sidebar/hooks/useSessionPrefetch';
import { useDirectoryStatusProbe } from './sidebar/hooks/useDirectoryStatusProbe';
import { useSessionActions } from './sidebar/hooks/useSessionActions';
import { useSidebarPersistence } from './sidebar/hooks/useSidebarPersistence';
import { useProjectRepoStatus } from './sidebar/hooks/useProjectRepoStatus';
import { useProjectSessionLists } from './sidebar/hooks/useProjectSessionLists';
import { useSessionFolderCleanup } from './sidebar/hooks/useSessionFolderCleanup';
import { useStickyProjectHeaders } from './sidebar/hooks/useStickyProjectHeaders';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { SessionGroupSection } from './sidebar/SessionGroupSection';
import { SidebarHeader } from './sidebar/SidebarHeader';
import { SidebarActivitySections } from './sidebar/SidebarActivitySections';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarProjectsList } from './sidebar/SidebarProjectsList';
import { SessionNodeItem } from './sidebar/SessionNodeItem';
import { useUpdateStore } from '@/stores/useUpdateStore';
import type { SortableDragHandleProps } from './sidebar/sortableItems';
import {
  FolderDeleteConfirmDialog,
  SessionDeleteConfirmDialog,
  type DeleteFolderConfirmState,
  type DeleteSessionConfirmState,
} from './sidebar/ConfirmDialogs';
import { type SessionGroup, type SessionNode } from './sidebar/types';
import {
  addActiveNowSession,
  deriveActiveNowSessions,
  persistActiveNowEntries,
  pruneActiveNowEntries,
  readActiveNowEntries,
} from './sidebar/activitySections';
import {
  compareSessionsByPinnedAndTime,
  formatProjectLabel,
  normalizePath,
} from './sidebar/utils';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_ORDER_STORAGE_KEY = 'oc.sessions.groupOrder';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents';
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

const getPrVisualState = (status: GitHubPullRequestStatus | null): PrVisualState | null => {
  const pr = status?.pr;
  if (!pr) {
    return null;
  }
  if (pr.state === 'merged') {
    return 'merged';
  }
  if (pr.state === 'closed') {
    return 'closed';
  }
  if (pr.draft) {
    return 'draft';
  }
  const checksFailed = status?.checks?.state === 'failure';
  const mergeableState = typeof pr.mergeableState === 'string' ? pr.mergeableState : '';
  const notMergeable = pr.mergeable === false || mergeableState === 'blocked' || mergeableState === 'dirty';
  if (checksFailed || notMergeable) {
    return 'blocked';
  }
  return 'open';
};

const getPrVisualPriority = (state: PrVisualState): number => {
  switch (state) {
    case 'open':
      return 5;
    case 'blocked':
      return 4;
    case 'draft':
      return 3;
    case 'merged':
      return 2;
    case 'closed':
      return 1;
    default:
      return 0;
  }
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
  const { t } = useTranslation();
  const [isSessionSearchOpen, setIsSessionSearchOpen] = React.useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState('');
  const sessionSearchContainerRef = React.useRef<HTMLDivElement | null>(null);
  const sessionSearchInputRef = React.useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editingProjectDialogId, setEditingProjectDialogId] = React.useState<string | null>(null);
  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const [directoryStatus, setDirectoryStatus] = React.useState<Map<string, 'unknown' | 'exists' | 'missing'>>(
    () => new Map(),
  );
  const safeStorage = React.useMemo(() => getSafeStorage(), []);
  const [activeNowEntries, setActiveNowEntries] = React.useState(() => readActiveNowEntries(safeStorage));
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(new Set());

  const [projectRepoStatus, setProjectRepoStatus] = React.useState<Map<string, boolean | null>>(new Map());
  const [expandedSessionGroups, setExpandedSessionGroups] = React.useState<Set<string>>(new Set());
  const [hoveredProjectId, setHoveredProjectId] = React.useState<string | null>(null);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(false);
  const [projectNotesPanelOpen, setProjectNotesPanelOpen] = React.useState(false);
  const [openSidebarMenuKey, setOpenSidebarMenuKey] = React.useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = React.useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = React.useState('');
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<DeleteSessionConfirmState>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const [pinnedSessionIds, setPinnedSessionIds] = React.useState<Set<string>>(() => {
    try {
      const raw = getSafeStorage().getItem(SESSION_PINNED_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
    try {
      const raw = getSafeStorage().getItem(GROUP_COLLAPSE_STORAGE_KEY);
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
      const raw = getSafeStorage().getItem(GROUP_ORDER_STORAGE_KEY);
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
      const raw = getSafeStorage().getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
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
  const addProject = useProjectsStore((state) => state.addProject);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);

  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const toggleHelpDialog = useUIStore((state) => state.toggleHelpDialog);
  const setAboutDialogOpen = useUIStore((state) => state.setAboutDialogOpen);
  const deviceInfo = useDeviceInfo();
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
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
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const cleanupSessions = useSessionFoldersStore((state) => state.cleanupSessions);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);

  useSessionSearchEffects({
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchContainerRef,
  });

  const gitDirectories = useGitStore((state) => state.directories);

  const sessions = useSessionStore((state) => state.sessions);
  const archivedSessions = useSessionStore((state) => state.archivedSessions);
  const sessionsByDirectory = useSessionStore((state) => state.sessionsByDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionStore((state) => Boolean(state.newSessionDraft?.open));
  const setCurrentSession = useSessionStore((state) => state.setCurrentSession);
  const loadMessages = useSessionStore((state) => state.loadMessages);
  const updateSessionTitle = useSessionStore((state) => state.updateSessionTitle);
  const shareSession = useSessionStore((state) => state.shareSession);
  const unshareSession = useSessionStore((state) => state.unshareSession);
  const sessionMemoryState = useSessionStore((state) => state.sessionMemoryState);
  const sessionStatus = useSessionStore((state) => state.sessionStatus);
  const sessionAttentionStates = useSessionStore((state) => state.sessionAttentionStates);
  const permissions = useSessionStore((state) => state.permissions);
  const worktreeMetadata = useSessionStore((state) => state.worktreeMetadata);
  const availableWorktreesByProject = useSessionStore((state) => state.availableWorktreesByProject);
  const getSessionsByDirectory = useSessionStore((state) => state.getSessionsByDirectory);
  const openNewSessionDraft = useSessionStore((state) => state.openNewSessionDraft);
  const prStatusEntries = useGitHubPrStatusStore((state) => state.entries);
  const updateStore = useUpdateStore();

  const tauriIpcAvailable = React.useMemo(() => isTauriShell(), []);
  const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);
  const showDesktopSidebarChrome = !mobileVariant && !isVSCode;
  const desktopSidebarTopPaddingClass = isDesktopShellRuntime && isMacPlatform && !isDesktopWindowFullscreen ? 'pl-[5.5rem]' : 'pl-3';
  const desktopSidebarToggleButtonClass = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center rounded-md typography-ui-label font-medium text-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50';

  React.useEffect(() => {
    if (!isDesktopShellRuntime || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;
    let unlistenResize: (() => void) | null = null;

    const syncFullscreenState = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        const fullscreen = await currentWindow.isFullscreen();
        if (!disposed) {
          setIsDesktopWindowFullscreen(fullscreen);
        }
      } catch {
        if (!disposed) {
          setIsDesktopWindowFullscreen(false);
        }
      }
    };

    const attach = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        unlistenResize = await currentWindow.onResized(() => {
          void syncFullscreenState();
        });
      } catch {
        // Ignore listener setup failures; fallback state remains false.
      }
    };

    void syncFullscreenState();
    void attach();

    return () => {
      disposed = true;
      if (unlistenResize) {
        unlistenResize();
      }
    };
  }, [isDesktopShellRuntime, isMacPlatform]);

  const handleDesktopSidebarDragStart = React.useCallback(async (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (!isDesktopShellRuntime) {
      return;
    }

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const appWindow = getCurrentWindow();
      await appWindow.startDragging();
    } catch (error) {
      console.error('Failed to start window dragging:', error);
    }
  }, [isDesktopShellRuntime]);

  const {
    buildGroupSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  } = useSessionGrouping({
    homeDirectory,
    worktreeMetadata,
    pinnedSessionIds,
    gitDirectories,
    isVSCode,
  });

  const { scheduleCollapsedProjectsPersist } = useSidebarPersistence({
    isVSCode,
    safeStorage,
    keys: {
      sessionExpanded: SESSION_EXPANDED_STORAGE_KEY,
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

  const togglePinnedSession = React.useCallback((sessionId: string) => {
    setPinnedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const sortedSessions = React.useMemo(() => {
    return [...sessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));
  }, [sessions, pinnedSessionIds]);

  const allKnownSessionsById = React.useMemo(() => {
    const next = new Map<string, Session>();
    [...sessions, ...archivedSessions].forEach((session) => {
      next.set(session.id, session);
    });
    return next;
  }, [sessions, archivedSessions]);

  React.useEffect(() => {
    const pruned = pruneActiveNowEntries(activeNowEntries, allKnownSessionsById);
    if (pruned.length === activeNowEntries.length && pruned.every((entry, index) => entry.sessionId === activeNowEntries[index]?.sessionId)) {
      return;
    }
    setActiveNowEntries(pruned);
    persistActiveNowEntries(safeStorage, pruned);
  }, [activeNowEntries, allKnownSessionsById, safeStorage]);

  const previousStreamingIdsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const nextStreamingIds = new Set<string>();
    sessionStatus?.forEach((status, sessionId) => {
      if (status?.type === 'busy' || status?.type === 'retry') {
        nextStreamingIds.add(sessionId);
      }
    });

    const previousStreamingIds = previousStreamingIdsRef.current;
    const startedStreamingIds = Array.from(nextStreamingIds).filter((sessionId) => !previousStreamingIds.has(sessionId));
    if (startedStreamingIds.length > 0) {
      setActiveNowEntries((prev) => {
        const next = startedStreamingIds.reduce((entries, sessionId) => addActiveNowSession(entries, sessionId), prev);
        if (next === prev) {
          return prev;
        }
        persistActiveNowEntries(safeStorage, next);
        return next;
      });
    }

    previousStreamingIdsRef.current = nextStreamingIds;
  }, [sessionStatus, safeStorage]);

  React.useEffect(() => {
    const busyIds: string[] = [];
    sessionStatus?.forEach((status, sessionId) => {
      if (status?.type === 'busy' || status?.type === 'retry') {
        busyIds.push(sessionId);
      }
    });

    if (busyIds.length === 0) {
      return;
    }

    setActiveNowEntries((prev) => {
      const known = new Set(prev.map((entry) => entry.sessionId));
      let next = prev;
      let changed = false;

      busyIds.forEach((sessionId) => {
        if (known.has(sessionId)) {
          return;
        }

        const session = allKnownSessionsById.get(sessionId);
        if (!session || session.time?.archived) {
          return;
        }

        const isSubtask = Boolean((session as Session & { parentID?: string | null }).parentID);
        if (isSubtask) {
          return;
        }

        next = addActiveNowSession(next, sessionId);
        known.add(sessionId);
        changed = true;
      });

      if (!changed) {
        return prev;
      }

      persistActiveNowEntries(safeStorage, next);
      return next;
    });
  }, [sessionStatus, allKnownSessionsById, safeStorage]);

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

  useDirectoryStatusProbe({
    sortedSessions,
    projects,
    directoryStatus,
    setDirectoryStatus,
  });

  const emptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessionsSidebar.noSessionsYet')}</p>
      <p className="typography-meta mt-1">{t('sessionsSidebar.createFirstSession')}</p>
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
  }, []);

  const handleOpenUpdateDialog = React.useCallback(() => {
    const current = useUpdateStore.getState();
    if (current.available && current.info) {
      setUpdateDialogOpen(true);
      return;
    }

    void updateStore.checkForUpdates().then(() => {
      const { available, error } = useUpdateStore.getState();
      if (error) {
        toast.error(t('sessionsSidebar.failedCheckForUpdates'), { description: error });
        return;
      }
      if (!available) {
        toast.success(t('sessionsSidebar.latestVersion'));
        return;
      }
      setUpdateDialogOpen(true);
    });
  }, [t, updateStore]);

  const showSidebarUpdateButton =
    updateStore.available &&
    (updateStore.runtimeType === 'desktop' || updateStore.runtimeType === 'web');

  const deleteSession = useSessionStore((state) => state.deleteSession);
  const deleteSessions = useSessionStore((state) => state.deleteSessions);
  const archiveSession = useSessionStore((state) => state.archiveSession);
  const archiveSessions = useSessionStore((state) => state.archiveSessions);

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
    if (!tauriIpcAvailable || !isDesktopLocalOriginActive()) {
      sessionEvents.requestDirectoryDialog();
      return;
    }

    import('@/lib/desktop')
      .then(({ requestDirectoryAccess }) => requestDirectoryAccess(''))
      .then((result) => {
        if (result.success && result.path) {
          const added = addProject(result.path, { id: result.projectId });
          if (!added) {
            toast.error(t('sessionsSidebar.failedAddProject'), {
              description: t('sessionsSidebar.pleaseSelectValidDirectory'),
            });
          }
        } else if (result.error && result.error !== 'Directory selection cancelled') {
          toast.error(t('sessionsSidebar.failedSelectDirectory'), {
            description: result.error,
          });
        }
      })
      .catch((error) => {
        console.error('Desktop: Error selecting directory:', error);
        toast.error(t('sessionsSidebar.failedSelectDirectory'));
      });
  }, [addProject, t, tauriIpcAvailable]);

  const toggleParent = React.useCallback((sessionId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        return next;
      }
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

      const newFolder = createFolder(scopeKey, 'New folder', parentId);
      setRenamingFolderId(newFolder.id);
      setRenameFolderDraft(newFolder.name);
      return newFolder;
    },
    [collapsedFolderIds, toggleFolderCollapse, createFolder],
  );

  const toggleGroupSessionLimit = React.useCallback((groupId: string) => {
    setExpandedSessionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const collapseAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
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
  }, [isVSCode, safeStorage, scheduleCollapsedProjectsPersist]);

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

  useProjectRepoStatus({
    projects,
    normalizedProjects,
    normalizePath,
    gitDirectories,
    setProjectRepoStatus,
    setProjectRootBranches,
  });

  const isSessionsLoading = useSessionStore((state) => state.isLoading);
  useSessionFolderCleanup({
    isSessionsLoading,
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
    sessionsByDirectory,
    getSessionsByDirectory,
    availableWorktreesByProject,
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
    getFoldersForScope,
  });

  const searchEmptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessionsSidebar.noMatchingSessions')}</p>
      <p className="typography-meta mt-1">Try a different title, branch, folder, or path.</p>
    </div>
  );

  const activeProjectForHeader = React.useMemo(
    () => normalizedProjects.find((project) => project.id === activeProjectId) ?? normalizedProjects[0] ?? null,
    [normalizedProjects, activeProjectId],
  );
  const activeProjectRefForHeader = React.useMemo(
    () => (activeProjectForHeader
      ? {
        id: activeProjectForHeader.id,
        path: activeProjectForHeader.normalizedPath,
      }
      : null),
    [activeProjectForHeader],
  );
  const activeProjectLabelForHeader = React.useMemo(
    () => (activeProjectForHeader
      ? activeProjectForHeader.label?.trim()
        || formatDirectoryName(activeProjectForHeader.normalizedPath, homeDirectory)
        || activeProjectForHeader.normalizedPath
      : null),
    [activeProjectForHeader, homeDirectory],
  );

  const activeProjectIsRepo = React.useMemo(
    () => (activeProjectForHeader ? Boolean(projectRepoStatus.get(activeProjectForHeader.id)) : false),
    [activeProjectForHeader, projectRepoStatus],
  );
  // Only flip to false once the new project's status is actually resolved (present in map)
  const stableActiveProjectIsRepo = activeProjectForHeader && projectRepoStatus.has(activeProjectForHeader.id)
    ? activeProjectIsRepo
    : lastRepoStatusRef.current;
  const reserveHeaderActionsSpace = true;
  const useMobileNotesPanel = mobileVariant || deviceInfo.isMobile;

  React.useEffect(() => {
    if (!activeProjectForHeader) {
      setProjectNotesPanelOpen(false);
    }
  }, [activeProjectForHeader]);

  const { currentSessionDirectory } = useProjectSessionSelection({
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
    sessions,
    worktreeMetadata,
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

    projectSections.forEach((section) => {
      const projectLabel = formatProjectLabel(
        section.project.label?.trim()
        || formatDirectoryName(section.project.normalizedPath, homeDirectory)
        || section.project.normalizedPath,
      );
      section.groups.forEach((group) => {
        const secondaryMeta = group.branch && group.branch !== projectLabel
          ? { projectLabel, branchLabel: group.branch }
          : { projectLabel, branchLabel: null };

        const visit = (nodes: SessionNode[]) => {
          nodes.forEach((node) => {
            meta.set(node.session.id, {
              node,
              projectId: section.project.id,
              groupDirectory: group.directory,
              secondaryMeta,
            });
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

  const activeNowSessions = React.useMemo(
    () => deriveActiveNowSessions(activeNowEntries, new Map(sessions.map((session) => [session.id, session]))),
    [activeNowEntries, sessions],
  );

  useSessionPrefetch({
    currentSessionId,
    sortedSessions,
    recentSessionIds: activeNowSessions.map((session) => session.id),
    loadMessages,
  });

  const activitySections = React.useMemo(() => {
    const toItem = (session: Session) => {
      const existing = sessionSidebarMetaById.get(session.id);
      const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      return {
        node: existing?.node ?? { session, children: [], worktree: null },
        projectId: existing?.projectId ?? null,
        groupDirectory: existing?.groupDirectory ?? sessionDirectory,
        secondaryMeta: existing?.secondaryMeta ?? null,
      };
    };

    return [
      { key: 'active-now' as const, title: 'recent', items: activeNowSessions.map(toItem) },
    ];
  }, [activeNowSessions, sessionSidebarMetaById]);

  const recentSessionIds = React.useMemo(() => {
    return new Set(activitySections.flatMap((section) => section.items.map((item) => item.node.session.id)));
  }, [activitySections]);

  const sectionsForSidebarRender = React.useMemo(() => {
    if (!isVSCode || hasSessionSearchQuery || recentSessionIds.size === 0) {
      return sectionsForRender;
    }

    const filterNodes = (nodes: SessionNode[]): SessionNode[] => {
      return nodes.reduce<SessionNode[]>((acc, node) => {
        if (recentSessionIds.has(node.session.id)) {
          return acc;
        }

        const filteredChildren = filterNodes(node.children);
        if (filteredChildren.length === node.children.length) {
          acc.push(node);
          return acc;
        }

        acc.push({
          ...node,
          children: filteredChildren,
        });
        return acc;
      }, []);
    };

    return sectionsForRender.map((section) => ({
      ...section,
      groups: section.groups.map((group) => ({
        ...group,
        sessions: filterNodes(group.sessions),
      })),
    }));
  }, [isVSCode, hasSessionSearchQuery, recentSessionIds, sectionsForRender]);

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

  const renderSessionNode = React.useCallback(
    (
      node: SessionNode,
      depth = 0,
      groupDirectory?: string | null,
      projectId?: string | null,
      archivedBucket = false,
      secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
      renderContext: 'project' | 'recent' = 'project',
    ): React.ReactNode => (
      <SessionNodeItem
        node={node}
        depth={depth}
        groupDirectory={groupDirectory}
        projectId={projectId}
        archivedBucket={archivedBucket}
        directoryStatus={directoryStatus}
        sessionMemoryState={sessionMemoryState as Map<string, { isZombie?: boolean }>}
        currentSessionId={currentSessionId}
        pinnedSessionIds={pinnedSessionIds}
        expandedParents={expandedParents}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        sessionAttentionStates={sessionAttentionStates as Map<string, { needsAttention?: boolean }>}
        notifyOnSubtasks={notifyOnSubtasks}
        sessionStatus={sessionStatus as Map<string, { type?: string }> | undefined}
        permissions={permissions as Map<string, unknown[]>}
        editingId={editingId}
        setEditingId={setEditingId}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        handleSaveEdit={handleSaveEdit}
        handleCancelEdit={handleCancelEdit}
        toggleParent={toggleParent}
        handleSessionSelect={handleSessionSelect}
        handleSessionDoubleClick={handleSessionDoubleClick}
        togglePinnedSession={togglePinnedSession}
        handleShareSession={handleShareSession}
        copiedSessionId={copiedSessionId}
        handleCopyShareUrl={handleCopyShareUrl}
        handleUnshareSession={handleUnshareSession}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        renamingFolderId={renamingFolderId}
        getFoldersForScope={getFoldersForScope}
        getSessionFolderId={getSessionFolderId}
        removeSessionFromFolder={removeSessionFromFolder}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={createFolderAndStartRename}
        openContextPanelTab={openContextPanelTab}
        handleDeleteSession={handleDeleteSession}
        mobileVariant={mobileVariant}
        renderSessionNode={renderSessionNode}
        secondaryMeta={secondaryMeta}
        renderContext={renderContext}
      />
    ),
    [
      directoryStatus,
      sessionMemoryState,
      currentSessionId,
      pinnedSessionIds,
      expandedParents,
      hasSessionSearchQuery,
      normalizedSessionSearchQuery,
      sessionAttentionStates,
      notifyOnSubtasks,
      sessionStatus,
      permissions,
      editingId,
      setEditingId,
      editTitle,
      setEditTitle,
      handleSaveEdit,
      handleCancelEdit,
      toggleParent,
      handleSessionSelect,
      handleSessionDoubleClick,
      togglePinnedSession,
      handleShareSession,
      copiedSessionId,
      handleCopyShareUrl,
      handleUnshareSession,
      openSidebarMenuKey,
      setOpenSidebarMenuKey,
      renamingFolderId,
      getFoldersForScope,
      getSessionFolderId,
      removeSessionFromFolder,
      addSessionToFolder,
      createFolderAndStartRename,
      openContextPanelTab,
      handleDeleteSession,
      mobileVariant,
    ],
  );

  const toggleCollapsedGroup = React.useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const prVisualStateByDirectoryBranch = React.useMemo(() => {
    const result = new Map<string, PrIndicator>();

    Object.values(prStatusEntries).forEach((entry) => {
      const directory = normalizePath(entry.params?.directory ?? entry.identity?.directory ?? null);
      const branch = entry.params?.branch?.trim() ?? entry.identity?.branch?.trim();
      if (!directory || !branch) {
        return;
      }
      const state = getPrVisualState(entry.status ?? null);
      const pr = entry.status?.pr;
      if (!state || !pr?.number) {
        return;
      }

      const key = `${directory}::${branch}`;
      const nextIndicator: PrIndicator = {
        visualState: state,
        number: pr.number,
        url: typeof pr.url === 'string' && pr.url.trim().length > 0 ? pr.url : null,
        state: pr.state,
        draft: Boolean(pr.draft),
        title: typeof pr.title === 'string' && pr.title.trim().length > 0 ? pr.title : null,
        base: typeof pr.base === 'string' && pr.base.trim().length > 0 ? pr.base : null,
        head: typeof pr.head === 'string' && pr.head.trim().length > 0 ? pr.head : null,
        checks: entry.status?.checks
          ? {
            state: entry.status.checks.state,
            total: entry.status.checks.total,
            success: entry.status.checks.success,
            failure: entry.status.checks.failure,
            pending: entry.status.checks.pending,
          }
          : null,
        canMerge: typeof entry.status?.canMerge === 'boolean' ? entry.status.canMerge : null,
        mergeableState: typeof pr.mergeableState === 'string' ? pr.mergeableState : null,
        repo: entry.status?.repo
          ? {
            owner: entry.status.repo.owner,
            repo: entry.status.repo.repo,
          }
          : null,
      };
      const existing = result.get(key);
      if (!existing || getPrVisualPriority(nextIndicator.visualState) > getPrVisualPriority(existing.visualState)) {
        result.set(key, nextIndicator);
      }
    });

    return result;
  }, [prStatusEntries]);

  const renderGroupSessions = React.useCallback(
    (group: SessionGroup, groupKey: string, projectId?: string | null, hideGroupLabel?: boolean, dragHandleProps?: SortableDragHandleProps | null, compactBodyPadding?: boolean) => (
      <SessionGroupSection
        group={group}
        groupKey={groupKey}
        projectId={projectId}
        hideGroupLabel={hideGroupLabel}
        compactBodyPadding={compactBodyPadding}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        groupSearchDataByGroup={groupSearchDataByGroup}
        expandedSessionGroups={expandedSessionGroups}
        collapsedGroups={collapsedGroups}
        hideDirectoryControls={hideDirectoryControls}
        getFoldersForScope={getFoldersForScope}
        collapsedFolderIds={collapsedFolderIds}
        toggleFolderCollapse={toggleFolderCollapse}
        renameFolder={renameFolder}
        deleteFolder={deleteFolder}
        showDeletionDialog={showDeletionDialog}
        setDeleteFolderConfirm={setDeleteFolderConfirm}
        renderSessionNode={renderSessionNode}
        currentSessionDirectory={currentSessionDirectory}
        projectRepoStatus={projectRepoStatus}
        lastRepoStatus={lastRepoStatusRef.current}
        toggleGroupSessionLimit={toggleGroupSessionLimit}
        mobileVariant={mobileVariant}
        activeProjectId={activeProjectId}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraft}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={createFolderAndStartRename}
        renamingFolderId={renamingFolderId}
        renameFolderDraft={renameFolderDraft}
        setRenameFolderDraft={setRenameFolderDraft}
        setRenamingFolderId={setRenamingFolderId}
        pinnedSessionIds={pinnedSessionIds}
        prVisualStateByDirectoryBranch={prVisualStateByDirectoryBranch}
        onToggleCollapsedGroup={toggleCollapsedGroup}
        dragHandleProps={dragHandleProps}
      />
    ),
    [
      hasSessionSearchQuery,
      normalizedSessionSearchQuery,
      groupSearchDataByGroup,
      expandedSessionGroups,
      collapsedGroups,
      hideDirectoryControls,
      getFoldersForScope,
      collapsedFolderIds,
      toggleFolderCollapse,
      renameFolder,
      deleteFolder,
      showDeletionDialog,
      renderSessionNode,
      currentSessionDirectory,
      projectRepoStatus,
      toggleGroupSessionLimit,
      mobileVariant,
      activeProjectId,
      setActiveProjectIdOnly,
      setActiveMainTab,
      setSessionSwitcherOpen,
      openNewSessionDraft,
      addSessionToFolder,
      createFolderAndStartRename,
      renamingFolderId,
      renameFolderDraft,
      pinnedSessionIds,
      prVisualStateByDirectoryBranch,
      toggleCollapsedGroup,
    ],
  );

  const topContent = !hasSessionSearchQuery ? (
    <SidebarActivitySections
      sections={activitySections}
      renderSessionNode={renderSessionNode}
    />
  ) : null;
  const isInlineEditing = Boolean(renamingFolderId || editingId || editingProjectDialogId);
  const handleSidebarNewSession = React.useCallback(() => {
    setActiveMainTab('chat');
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openNewSessionDraft();
  }, [mobileVariant, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

  const handleOpenMultiRunFromHeader = React.useCallback(() => {
    setActiveMainTab('chat');
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openMultiRunLauncher();
  }, [mobileVariant, openMultiRunLauncher, setActiveMainTab, setSessionSwitcherOpen]);

  return (
    <div
      ref={sessionSearchContainerRef}
      className={cn(
        'relative flex h-full flex-col text-foreground overflow-x-hidden',
        mobileVariant ? '' : 'bg-transparent',
      )}
    >
      {showDesktopSidebarChrome ? (
        <div
          onMouseDown={handleDesktopSidebarDragStart}
          className={cn(
            'app-region-drag flex h-[var(--oc-header-height,56px)] flex-shrink-0 items-center pr-3',
            desktopSidebarTopPaddingClass,
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleSidebar}
                className={desktopSidebarToggleButtonClass}
                aria-label={t('sessionsSidebar.closeSessions')}
              >
                <RiLayoutLeftLine className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('sessionsSidebar.closeSessions')}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      <SidebarHeader
        hideDirectoryControls={hideDirectoryControls}
        handleOpenDirectoryDialog={handleOpenDirectoryDialog}
        handleNewSession={handleSidebarNewSession}
        useMobileNotesPanel={useMobileNotesPanel}
        projectNotesPanelOpen={projectNotesPanelOpen}
        setProjectNotesPanelOpen={setProjectNotesPanelOpen}
        activeProjectRefForHeader={activeProjectRefForHeader}
        activeProjectLabelForHeader={activeProjectLabelForHeader}
        canOpenMultiRun={projects.length > 0}
        openMultiRunLauncher={handleOpenMultiRunFromHeader}
        stableActiveProjectIsRepo={stableActiveProjectIsRepo}
        headerActionIconClass={headerActionIconClass}
        reserveHeaderActionsSpace={reserveHeaderActionsSpace}
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
      />

      <SidebarProjectsList
        topContent={topContent}
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
        hoveredProjectId={hoveredProjectId}
        setHoveredProjectId={setHoveredProjectId}
        isDesktopShellRuntime={isDesktopShellRuntime}
        stuckProjectHeaders={stuckProjectHeaders}
        mobileVariant={mobileVariant}
        toggleProject={toggleProject}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraft}
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

      <SidebarFooter
        onOpenSettings={() => setSettingsDialogOpen(true)}
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
            setCurrentSession(options.sessionId);
            return;
          }
          openNewSessionDraft({ directoryOverride: worktreePath });
        }}
      />

      {useMobileNotesPanel ? (
        <MobileOverlayPanel
          open={projectNotesPanelOpen}
          onClose={() => setProjectNotesPanelOpen(false)}
          title={activeProjectLabelForHeader ? t('sessionsSidebar.projectNotesWithName', { name: activeProjectLabelForHeader }) : t('sessionsSidebar.projectNotes')}
        >
          <ProjectNotesTodoPanel
            projectRef={activeProjectRefForHeader}
            projectLabel={activeProjectLabelForHeader}
            canCreateWorktree={stableActiveProjectIsRepo}
            onActionComplete={() => setProjectNotesPanelOpen(false)}
            className="p-0"
          />
        </MobileOverlayPanel>
      ) : null}

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
    </div>
  );
};
