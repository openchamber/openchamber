import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePrefetchSessionMessages } from '@/sync/use-sync';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { getGitHubPrStatusKey, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { useArchivedAutoFolders } from '../folders/useArchivedAutoFolders';
import { ProjectSessionSelectionEffect } from '../projects/useProjectSessionSelection';
import type { WorktreeMetadata } from '@/types/worktree';
import { useRecentSessionCollection, useSessionProjectCollection } from './sessionCollection';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';
import { useChildStoreManager } from '@/sync/sync-context';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { useProjectSessionLists } from '../projects/useProjectSessionLists';
import { useSessionSidebarSections } from '../projects/useSessionSidebarSections';
import { SessionPrefetchEffect } from './useSessionPrefetch';
import { normalizePath } from '../utils';
import type { SessionGroup } from '../types';
import { SessionProjectScroller } from '../projects/SessionProjectScroller';
import { useSessionGrouping } from '../projects/useSessionGrouping';
import { useStickyProjectHeaders } from '../projects/useStickyProjectHeaders';
import { SessionBulkActions } from '../folders/SessionBulkActions';
import { RecentSessionSection } from '../recent/RecentSessionSection';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import type { useSessionProjectViewState } from '../projects/useSessionProjectViewState';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { DeleteSessionConfirmState } from '../sessions/useSessionActions';
import { useExpandedParents } from '../sessions/useExpandedParents';
import { SessionGroupSection } from '../projects/SessionGroupSection';
import { CHAT_DRAFT_PROJECT_ID, getChatsRootForHome, getChatsRootFromDirectory } from '@/lib/chatDirectories';
import { isCapacitorApp } from '@/lib/platform';

const PR_NO_PR_RETRY_MS = 5 * 60_000;

const isRootSession = (session: Session): boolean => {
  // SAFETY: OpenCode attaches parentID to hierarchical session records,
  // although the SDK's base Session type does not currently declare it.
  return !(session as Session & { parentID?: string | null }).parentID;
};

type Project = {
  id: string;
  path: string;
  label?: string;
  normalizedPath: string;
  icon?: string;
  color?: string;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  iconBackground?: string;
};

type SessionProjectCollectionProps = {
  topology: {
    projects: Project[];
    availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
    knownDirectories: Set<string>;
    isVSCode: boolean;
    worktreeMetadata: Map<string, WorktreeMetadata>;
    gitBranches: Map<string, string | null>;
    projectRepoStatus: Map<string, boolean | null>;
    projectRootBranches: Map<string, string | null>;
    lastRepoStatus: boolean;
  };
  view: {
    isVisible: boolean;
    hasSessionSearchQuery: boolean;
    normalizedSessionSearchQuery: string;
    activeProjectId: string | null;
    showInlineArchived: boolean;
    useGroupedSections: boolean;
    homeDirectory: string | null;
    mobileVariant: boolean;
    hideDirectoryControls: boolean;
    showOnlyMainWorkspace: boolean;
    isDesktopShellRuntime: boolean;
    stickyZoneHeaders: boolean;
    projectSortOrder: import('@/stores/useSessionDisplayStore').ProjectSortOrder;
    emptyState: React.ReactNode;
    searchEmptyState: React.ReactNode;
    isSessionsLoading: boolean;
    isWorktreeTopologyLoading: boolean;
    unresolvedWorktreeProjectPaths: ReadonlySet<string>;
    projectView: ReturnType<typeof useSessionProjectViewState>['state'];
  };
  actions: {
    rowActions: {
      allowReselect: boolean;
      onSessionSelected?: (sessionId: string) => void;
      isSessionSearchOpen: boolean;
      sessionSearchQuery: string;
      setSessionSearchQuery: (value: string) => void;
      setIsSessionSearchOpen: (open: boolean) => void;
    };
    alwaysShowActions: boolean;
    notifyOnSubtasks: boolean;
    setActiveProjectIdOnly: (id: string) => void;
    setSessionSwitcherOpen: (open: boolean) => void;
    openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
    openNewWorktreeDialog: () => void;
    openWorktreesPage: (id: string) => void;
    openProjectEditDialog: (id: string) => void;
    removeProject: (id: string) => void;
    reorderProjects: (fromIndex: number, toIndex: number) => void;
    startSessionWorktreeMenuLoad: SessionTreeItemProps['startSessionWorktreeMenuLoad'];
    renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
    initialActiveSessionByProject: Map<string, string>;
    persistActiveSessionByProject: (value: Map<string, string>) => void;
    projectViewActions: Pick<
      ReturnType<typeof useSessionProjectViewState>['actions'],
      'getOrderedGroups' | 'setGroupOrderByProject' | 'toggleGroup' | 'toggleProject'
    >;
  };
};

const VisibleSessionProjects: React.FC<SessionProjectCollectionProps> = ({ topology, view, actions }) => {
  const { alwaysShowActions, notifyOnSubtasks, projectViewActions, rowActions, ...scrollerActions } = actions;
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const projectView = view.projectView;
  const { getOrderedGroups, setGroupOrderByProject, toggleGroup, toggleProject } = projectViewActions;
  const collection = useSessionProjectCollection({ knownDirectories: topology.knownDirectories, isVSCode: topology.isVSCode, isVisible: true });
  const [visibleSessionCountByGroup, setVisibleSessionCountByGroup] = React.useState<Map<string, number>>(new Map());
  const showMoreGroupSessions = React.useCallback((groupId: string, currentVisibleCount: number) => {
    setVisibleSessionCountByGroup((current) => new Map(current).set(groupId, currentVisibleCount + 7));
  }, []);
  const resetGroupSessionLimit = React.useCallback((groupId: string) => {
    setVisibleSessionCountByGroup((current) => {
      if (!current.has(groupId)) return current;
      const next = new Map(current);
      next.delete(groupId);
      return next;
    });
  }, []);
  const showRecentSection = useSessionDisplayStore((state) => state.showRecentSection);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const singleProjectId = useSessionDisplayStore((state) => state.singleProjectId);
  const setSingleProjectId = useSessionDisplayStore((state) => state.setSingleProjectId);
  const supportsSingleProjectMode = !topology.isVSCode && !isCapacitorApp();
  const singleProjectMode = supportsSingleProjectMode && projectDisplayMode === 'single';
  const recentSessions = useRecentSessionCollection({
    enabled: showRecentSection && !singleProjectMode,
    isVSCode: topology.isVSCode,
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderRanks: collection.sessionOrderRanks,
    sessions: collection.rootSessions,
  });
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [openSidebarMenuKey, setOpenSidebarMenuKey] = React.useState<string | null>(null);
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<DeleteSessionConfirmState>(null);
  const [copiedSessionId, setCopiedSessionId] = React.useState<string | null>(null);
  const [folderRename, setFolderRename] = React.useState<{ scopeKey: string; folderId: string; draft: string } | null>(null);
  const startFolderRename = React.useCallback((scopeKey: string, folder: { id: string; name: string }) => {
    setFolderRename({ scopeKey, folderId: folder.id, draft: folder.name });
  }, []);
  const setFolderRenameDraft = React.useCallback((draft: string) => {
    setFolderRename((current) => current ? { ...current, draft } : null);
  }, []);
  const clearFolderRename = React.useCallback(() => setFolderRename(null), []);
  const { expandedParents, toggleParent } = useExpandedParents();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const selectSessionForProject = React.useCallback((sessionId: string, sessionDirectory: string | null) => {
    if (sessionId === useSessionUIStore.getState().currentSessionId) return;
    setCurrentSession(sessionId, sessionDirectory);
  }, [setCurrentSession]);
  const prefetchSession = usePrefetchSessionMessages();
  const { buildGroupedSessions, filterSessionNodesForSearch, buildGroupSearchText } = useSessionGrouping({
    homeDirectory: view.homeDirectory,
    worktreeMetadata: topology.worktreeMetadata,
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderRanks: collection.sessionOrderRanks,
    gitBranches: topology.gitBranches,
    isVSCode: topology.isVSCode,
  });
  const ownership = React.useMemo(
    () => createSessionOwnershipIndex(collection.sessions, topology.projects, topology.availableWorktreesByProject, topology.isVSCode, collection.archivedSessions),
    [collection.archivedSessions, collection.sessions, topology.availableWorktreesByProject, topology.isVSCode, topology.projects],
  );
  const { getSessionsForProject, getArchivedSessionsForProject } = useProjectSessionLists({ ownership });
  const { projectSections, groupSearchDataByGroup, sectionsForRender, flatSectionsForRender } = useSessionSidebarSections({
    normalizedProjects: topology.projects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject: topology.availableWorktreesByProject,
    projectRepoStatus: topology.projectRepoStatus,
    projectRootBranches: topology.projectRootBranches,
    lastRepoStatus: topology.lastRepoStatus,
    buildGroupedSessions,
    hasSessionSearchQuery: view.hasSessionSearchQuery,
    normalizedSessionSearchQuery: view.normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    foldersMap,
  });

  // Second bootstrap-demand owner: the layout-level useSessionListSync keeps
  // every known directory alive at background priority even when the sidebar
  // is hidden, but only the visible collection knows which projects and
  // groups are EXPANDED. Without this owner, expanded projects bootstrapped
  // serialized at background priority (one directory at a time) instead of
  // concurrently at expanded priority.
  const childStores = useChildStoreManager();
  const expansionDemandOwner = `session-collection-expansion:${React.useId()}`;
  React.useEffect(() => {
    childStores.setBootstrapDemand(expansionDemandOwner, buildSessionBootstrapDemands({
      projectSections,
      activeProjectId: view.activeProjectId,
      collapsedProjects: projectView.collapsedProjects,
      collapsedGroups: projectView.collapsedGroups,
      currentDirectory: null,
      currentSessionDirectory: null,
    }));
    return () => childStores.clearBootstrapDemand(expansionDemandOwner);
  }, [childStores, expansionDemandOwner, projectSections, projectView.collapsedProjects, projectView.collapsedGroups, view.activeProjectId]);
  const source = view.useGroupedSections ? sectionsForRender : flatSectionsForRender;
  const sectionsForSidebarRender = React.useMemo(() => view.showInlineArchived ? source : source.map((section) => (
    section.groups.some((group) => group.isArchivedBucket)
      ? { ...section, groups: section.groups.filter((group) => !group.isArchivedBucket) }
      : section
  )), [source, view.showInlineArchived]);
  const getFolderScopesForProject = React.useCallback((projectId: string) => {
    const section = flatSectionsForRender.find((entry) => entry.project.id === projectId);
    return section?.groups.find((group) => !group.isArchivedBucket)?.folderScopes ?? [];
  }, [flatSectionsForRender]);
  const projectHeaderSentinelRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());
  const stuckProjectHeaders = useStickyProjectHeaders({
    enabled: view.stickyZoneHeaders,
    isDesktopShellRuntime: view.isDesktopShellRuntime,
    projectSections,
    projectHeaderSentinelRefs,
  });
  useArchivedAutoFolders({
    enabled: true,
    normalizedProjects: topology.projects,
    ownership,
    isSessionsLoading: view.isSessionsLoading,
    hasAuthoritativeGlobalSessions: collection.hasAuthoritativeGlobalSessions,
    isWorktreeTopologyLoading: view.isWorktreeTopologyLoading,
    unresolvedWorktreeProjectPaths: view.unresolvedWorktreeProjectPaths,
    foldersMap,
    createFolder,
    addSessionToFolder,
  });
  const { github } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const ensureEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshTargets = useGitHubPrStatusStore((state) => state.refreshTargets);
  const retriedRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!github || !githubAuthChecked || !githubAuthStatus?.connected) return;
    const targets = new Map<string, { directory: string; branch: string }>();
    const now = Date.now();
    projectSections.forEach((section) => {
      if (projectView.collapsedProjects.has(section.project.id)) return;
      section.groups.forEach((group) => {
        if (group.isArchivedBucket || group.isMain) return;
        const directory = normalizePath(group.directory ?? null);
        const branch = group.branch?.trim() || topology.gitBranches.get(directory || '')?.trim();
        if (!directory || !branch) return;
        const key = getGitHubPrStatusKey(directory, branch);
        const entry = useGitHubPrStatusStore.getState().entries[key];
        const terminal = entry?.status?.pr?.state === 'closed' || entry?.status?.pr?.state === 'merged';
        const retryKey = `${directory}::${branch}`;
        const lastChecked = Math.max(entry?.lastRefreshAt ?? 0, entry?.lastDiscoveryPollAt ?? 0);
        const retry = Boolean(entry?.isInitialStatusResolved && (!entry.status?.pr || terminal) && (!retriedRef.current.has(retryKey) || now - lastChecked >= PR_NO_PR_RETRY_MS));
        if (!entry || !entry.isInitialStatusResolved || retry) {
          if (retry) retriedRef.current.add(retryKey);
          targets.set(key, { directory, branch });
        }
      });
    });
    targets.forEach((target, key) => {
      ensureEntry(key);
      setParams(key, { ...target, remoteName: null, canShow: true, github, githubAuthChecked, githubConnected: githubAuthStatus.connected });
    });
    if (targets.size) void refreshTargets([...targets.values()], { silent: true, markInitialResolved: true });
  }, [ensureEntry, github, githubAuthChecked, githubAuthStatus?.connected, projectSections, projectView.collapsedProjects, refreshTargets, setParams, topology.gitBranches]);
  const sessionOrderIndex = React.useMemo(
    () => new Map(collection.orderedSessions.map((session, index) => [session.id, index])),
    [collection.orderedSessions],
  );
  const orderedSectionsForRender = React.useMemo(
    () => sectionsForSidebarRender.map((section) => {
      const groups = getOrderedGroups(section.project.id, section.groups);
      return groups === section.groups ? section : { ...section, groups };
    }),
    [getOrderedGroups, sectionsForSidebarRender],
  );
  let selectedSingleProjectId: string | null = null;
  if (singleProjectMode) {
    if (projectSections.some((section) => section.project.id === singleProjectId)) {
      selectedSingleProjectId = singleProjectId;
    } else if (projectSections.some((section) => section.project.id === view.activeProjectId)) {
      selectedSingleProjectId = view.activeProjectId;
    } else {
      selectedSingleProjectId = projectSections[0]?.project.id ?? null;
    }
  }
  const groupProps = React.useMemo(() => ({
    hasSessionSearchQuery: view.hasSessionSearchQuery,
    normalizedSessionSearchQuery: view.normalizedSessionSearchQuery,
    groupSearchDataByGroup,
    collapsedGroups: projectView.collapsedGroups,
    hideDirectoryControls: view.hideDirectoryControls,
    mobileVariant: view.mobileVariant,
    alwaysShowActions,
    activeProjectId: view.activeProjectId,
    notifyOnSubtasks,
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderIndex,
    expandedParents,
    editingId,
    editTitle,
    copiedSessionId,
    sessionBatchSize: singleProjectMode && !view.useGroupedSections ? 20 : undefined,
    setEditingId,
    setEditTitle,
    toggleParent,
    allowReselect: rowActions.allowReselect,
    onSessionSelected: rowActions.onSessionSelected,
    isSessionSearchOpen: rowActions.isSessionSearchOpen,
    sessionSearchQuery: rowActions.sessionSearchQuery,
    setSessionSearchQuery: rowActions.setSessionSearchQuery,
    setIsSessionSearchOpen: rowActions.setIsSessionSearchOpen,
    deleteSessionConfirm,
    setDeleteSessionConfirm,
    startFolderRename,
    setCopiedSessionId,
    startSessionWorktreeMenuLoad: actions.startSessionWorktreeMenuLoad,
    folderRename,
    setFolderRenameDraft,
    clearFolderRename,
  }), [
    collection.pinnedSessionIds,
    alwaysShowActions,
    notifyOnSubtasks,
    projectView.collapsedGroups,
    groupSearchDataByGroup,
    sessionOrderIndex,
    editTitle,
    editingId,
    expandedParents,
    folderRename,
    setFolderRenameDraft,
    clearFolderRename,
    startFolderRename,
    deleteSessionConfirm,
    copiedSessionId,
    setCopiedSessionId,
    actions.startSessionWorktreeMenuLoad,
    rowActions,
    toggleParent,
    view.hideDirectoryControls,
    view.hasSessionSearchQuery,
    view.activeProjectId,
    view.mobileVariant,
    view.normalizedSessionSearchQuery,
    view.useGroupedSections,
    singleProjectMode,
  ]);
  const groupActions = React.useMemo(() => ({
    showMoreGroupSessions,
    resetGroupSessionLimit,
    setActiveProjectIdOnly: scrollerActions.setActiveProjectIdOnly,
    setSessionSwitcherOpen: scrollerActions.setSessionSwitcherOpen,
    openNewSessionDraft: scrollerActions.openNewSessionDraft,
    onToggleCollapsedGroup: toggleGroup,
  }), [
    resetGroupSessionLimit,
    showMoreGroupSessions,
    toggleGroup,
    scrollerActions.openNewSessionDraft,
    scrollerActions.setActiveProjectIdOnly,
    scrollerActions.setSessionSwitcherOpen,
  ]);
  const chatGroup = React.useMemo<SessionGroup | null>(() => {
    if (topology.isVSCode) return null;
    const chatsRoot = getChatsRootForHome(view.homeDirectory)
      ?? collection.chatSessions.map((session) => getChatsRootFromDirectory(session.directory)).find(Boolean)
      ?? null;
    if (!chatsRoot) return null;
    const folderScopes = Array.from(new Set([
      chatsRoot,
      ...collection.chatSessions.map((session) => normalizePath(session.directory ?? null)).filter(Boolean),
    ])).filter((directory): directory is string => Boolean(directory))
      .map((directory) => ({ scopeKey: directory, directory }));
    return {
      id: 'managed-chats',
      label: '',
      branch: null,
      description: null,
      isMain: true,
      worktree: null,
      directory: chatsRoot,
      folderScopeKey: chatsRoot,
      folderScopes,
      draftTarget: 'chat',
      sessions: collection.chatSessions
        .filter((session) => !session.time?.archived && isRootSession(session))
        .map((session) => ({ session, children: (collection.childrenMap.get(session.id) ?? []).filter((child) => !child.time?.archived).map((child) => ({ session: child, children: [], worktree: null })), worktree: null })),
    };
  }, [collection.chatSessions, collection.childrenMap, topology.isVSCode, view.homeDirectory]);
  const renderChatsSection = React.useCallback(() => {
    if (!chatGroup) return null;
    return <SessionGroupSection
      {...groupProps}
      {...groupActions}
      group={chatGroup}
      groupKey="managed-chats"
      projectId={null}
      hideGroupLabel
      sessionBatchSize={20}
      scrollContainerRef={undefined}
      openSidebarMenuKey={openSidebarMenuKey}
      setOpenSidebarMenuKey={setOpenSidebarMenuKey}
    />;
  }, [chatGroup, groupActions, groupProps, openSidebarMenuKey]);
  const handleOpenNewChat = React.useCallback(() => {
    useUIStore.getState().closeMainSurfaces();
    if (view.mobileVariant) scrollerActions.setSessionSwitcherOpen(false);
    scrollerActions.openNewSessionDraft({ selectedProjectId: CHAT_DRAFT_PROJECT_ID, directoryOverride: null });
  }, [scrollerActions, view.mobileVariant]);
  const recentSection = React.useMemo(() => (
    !topology.isVSCode ? <RecentSessionSection
      projects={topology.projects}
      availableWorktreesByProject={topology.availableWorktreesByProject}
      gitBranches={topology.gitBranches}
      homeDirectory={view.homeDirectory}
      hasSessionSearchQuery={view.hasSessionSearchQuery}
      normalizedSessionSearchQuery={view.normalizedSessionSearchQuery}
      isDesktopShellRuntime={view.isDesktopShellRuntime}
      sessions={recentSessions}
      childrenMap={collection.childrenMap}
      pinnedSessionIds={collection.pinnedSessionIds}
      recentSessions={recentSessions}
      expandedParents={expandedParents}
      notifyOnSubtasks={notifyOnSubtasks}
      editingId={editingId}
      editTitle={editTitle}
      copiedSessionId={copiedSessionId}
      openSidebarMenuKey={openSidebarMenuKey}
      mobileVariant={view.mobileVariant}
      alwaysShowActions={alwaysShowActions}
      setEditingId={setEditingId}
      setEditTitle={setEditTitle}
      toggleParent={toggleParent}
      setOpenSidebarMenuKey={setOpenSidebarMenuKey}
      allowReselect={rowActions.allowReselect}
      onSessionSelected={rowActions.onSessionSelected}
      isSessionSearchOpen={rowActions.isSessionSearchOpen}
      sessionSearchQuery={rowActions.sessionSearchQuery}
      setSessionSearchQuery={rowActions.setSessionSearchQuery}
      setIsSessionSearchOpen={rowActions.setIsSessionSearchOpen}
      deleteSessionConfirm={deleteSessionConfirm}
      setDeleteSessionConfirm={setDeleteSessionConfirm}
      startFolderRename={startFolderRename}
      setCopiedSessionId={setCopiedSessionId}
      startSessionWorktreeMenuLoad={actions.startSessionWorktreeMenuLoad}
      chatSessions={collection.chatSessions}
      renderChatsSection={renderChatsSection}
      onNewChat={handleOpenNewChat}
      showRecentSection={showRecentSection && !singleProjectMode}
    /> : null
  ), [
    actions.startSessionWorktreeMenuLoad,
    alwaysShowActions,
    collection.childrenMap,
    collection.pinnedSessionIds,
    copiedSessionId,
    deleteSessionConfirm,
    editTitle,
    editingId,
    expandedParents,
    notifyOnSubtasks,
    openSidebarMenuKey,
    recentSessions,
    rowActions,
    showRecentSection,
    singleProjectMode,
    handleOpenNewChat,
    renderChatsSection,
    startFolderRename,
    toggleParent,
    topology.availableWorktreesByProject,
    topology.gitBranches,
    topology.isVSCode,
    topology.projects,
    collection.chatSessions,
    view.hasSessionSearchQuery,
    view.homeDirectory,
    view.isDesktopShellRuntime,
    view.mobileVariant,
    view.normalizedSessionSearchQuery,
  ]);
  const scrollerModel = React.useMemo(() => ({
    topContent: recentSection,
    hasSharedSessions: Boolean(recentSection),
    sectionsForRender: orderedSectionsForRender,
    projectSections,
    activeProjectId: view.activeProjectId,
    singleProjectMode,
    singleProjectId: selectedSingleProjectId,
    emptyState: view.emptyState,
    searchEmptyState: view.searchEmptyState,
    projectRepoStatus: topology.projectRepoStatus,
    stuckProjectHeaders,
    projectHeaderSentinelRefs,
    state: { editingId, openSidebarMenuKey, setOpenSidebarMenuKey, visibleSessionCountByGroup },
    groupProps,
  }), [
    groupProps,
    editingId,
    openSidebarMenuKey,
    projectSections,
    orderedSectionsForRender,
    stuckProjectHeaders,
    topology.projectRepoStatus,
    view.activeProjectId,
    view.emptyState,
    view.searchEmptyState,
    visibleSessionCountByGroup,
    recentSection,
    singleProjectMode,
    selectedSingleProjectId,
  ]);
  const scrollerView = React.useMemo(() => ({
    homeDirectory: view.homeDirectory,
    collapsedProjects: projectView.collapsedProjects,
    showOnlyMainWorkspace: view.showOnlyMainWorkspace,
    hasSessionSearchQuery: view.hasSessionSearchQuery,
    normalizedSessionSearchQuery: view.normalizedSessionSearchQuery,
    hideDirectoryControls: view.hideDirectoryControls,
    isDesktopShellRuntime: view.isDesktopShellRuntime,
    stickyZoneHeaders: view.stickyZoneHeaders,
    mobileVariant: view.mobileVariant,
    alwaysShowActions,
    projectSortOrder: view.projectSortOrder,
  }), [
    projectView.collapsedProjects,
    view.homeDirectory,
    view.hasSessionSearchQuery,
    view.hideDirectoryControls,
    view.isDesktopShellRuntime,
    view.mobileVariant,
    alwaysShowActions,
    view.normalizedSessionSearchQuery,
    view.projectSortOrder,
    view.showOnlyMainWorkspace,
    view.stickyZoneHeaders,
  ]);
  const scrollerActionSet = React.useMemo(() => ({
    group: groupActions,
    toggleProject,
    setActiveProjectIdOnly: scrollerActions.setActiveProjectIdOnly,
    setSessionSwitcherOpen: scrollerActions.setSessionSwitcherOpen,
    openNewSessionDraft: scrollerActions.openNewSessionDraft,
    openNewWorktreeDialog: scrollerActions.openNewWorktreeDialog,
    openWorktreesPage: scrollerActions.openWorktreesPage,
    openProjectEditDialog: scrollerActions.openProjectEditDialog,
    removeProject: scrollerActions.removeProject,
    reorderProjects: scrollerActions.reorderProjects,
    setGroupOrderByProject,
    renderProjectStatusIndicator: scrollerActions.renderProjectStatusIndicator,
    setSingleProjectId,
  }), [
    groupActions,
    scrollerActions.openNewSessionDraft,
    scrollerActions.openNewWorktreeDialog,
    scrollerActions.openProjectEditDialog,
    scrollerActions.openWorktreesPage,
    scrollerActions.removeProject,
    scrollerActions.reorderProjects,
    scrollerActions.setActiveProjectIdOnly,
    scrollerActions.setSessionSwitcherOpen,
    setGroupOrderByProject,
    toggleProject,
    scrollerActions.renderProjectStatusIndicator,
    setSingleProjectId,
  ]);
  return <>
    <ProjectSessionSelectionEffect
      projectSections={projectSections}
      activeProjectId={view.activeProjectId}
      initialActiveSessionByProject={actions.initialActiveSessionByProject}
      persistActiveSessionByProject={actions.persistActiveSessionByProject}
      mobileVariant={view.mobileVariant}
      openNewSessionDraft={actions.openNewSessionDraft}
      setSessionSwitcherOpen={actions.setSessionSwitcherOpen}
      sessionOwnerBySessionId={ownership.bySessionId}
      handleSessionSelect={selectSessionForProject}
    />
    <SessionPrefetchEffect
      sortedSessions={collection.orderedSessions}
      recentSessions={recentSessions}
      prefetchSession={prefetchSession}
    />
    <SessionProjectScroller model={scrollerModel} view={scrollerView} actions={scrollerActionSet} />
    <SessionBulkActions
      getFolderScopesForProject={getFolderScopesForProject}
      isInlineEditing={editingId !== null}
      startFolderRename={startFolderRename}
    />
  </>;
};

export const SessionProjectCollection: React.FC<SessionProjectCollectionProps> = (props) => props.view.isVisible ? <VisibleSessionProjects {...props} /> : null;
