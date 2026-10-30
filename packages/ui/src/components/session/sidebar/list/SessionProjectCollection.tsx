import { SidebarTerminalActivity } from './SidebarTerminalActivity';
import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePrefetchSessionMessages } from '@/sync/use-sync';
import {
  getSourceControlAuthKey,
  getSourceControlReadContextAuthState,
  useSourceControlAuthStore,
} from '@/stores/useSourceControlAuthStore';
import {
  getActiveSourceControlStatusKeys,
  getGitHubPrStatusKey,
  getSourceControlStatusKey,
  useBranchTrackedPulls,
  useGitHubPrStatusStore,
} from '@/stores/useGitHubPrStatusStore';
import { repositoryBindingOwner } from '@/lib/source-control/repository-binding';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import type { SourceControlReadContext } from '@/lib/api/types';
import { limitSourceControlDiscoveryCandidates } from '../sourceControlDiscovery';
import { reconcileRegisteredContextDirectories, type RegisteredContextDirectories } from './registeredContextDirectories';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getLinkedSidebarChanges, getLinkedSidebarIssues, type RepositoryThreadRef } from '@/lib/linkedIssues';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import { repositoryThread, workItem } from '@/lib/trackedItems/fromLinks';
import type { TrackedItem } from '@/lib/trackedItems/model';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { useArchivedAutoFolders } from '../folders/useArchivedAutoFolders';
import { ProjectSessionSelectionEffect } from '../projects/useProjectSessionSelection';
import type { WorktreeMetadata } from '@/types/worktree';
import { buildActiveSessionNode, useSessionProjectCollection } from './sessionCollection';
import { useChildStoreManager } from '@/sync/sync-context';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { useProjectSessionLists } from '../projects/useProjectSessionLists';
import { useSessionSidebarSections } from '../projects/useSessionSidebarSections';
import { SessionPrefetchProvider } from './useSessionPrefetch';
import { isPathWithinProject, normalizePath } from '../utils';
import type { SessionGroup, SessionNode } from '../types';
import { SessionProjectScroller, type SessionProjectListProps } from '../projects/SessionProjectScroller';
import { useSessionGrouping } from '../projects/useSessionGrouping';
import { SessionBulkActions } from '../folders/SessionBulkActions';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { isWorkExpanded, type useSessionProjectViewState } from '../projects/useSessionProjectViewState';
import { resolveSidebarGrouping, useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { holdOrder, rankByLatestActivity } from './projectSort';
import type { DeleteSessionConfirmState } from '../sessions/useSessionActions';
import { useExpandedParents } from '../sessions/useExpandedParents';
import { getChatsRootFromDirectory, isChatDirectoryPath } from '@/lib/chatDirectories';
import { useChatsRoot } from '@/hooks/useChatsRoot';
import { isVSCodeWithoutWorkspace } from '@/lib/vscodeBootstrap';
import { isCapacitorApp } from '@/lib/platform';
import { deriveTimelineActivityItems, matchZoneSessionsForSidebarQuery, pruneSessionTreeForSidebarQuery } from '../recent/activitySections';
import { resolveSidebarSessionLocations } from '../recent/sessionLocation';
import { buildSessionSidebarRowModel, type SessionSidebarWorkEntry } from '../sessionSidebarRowModel';
import { useRemovingWorktreePaths } from '@/lib/worktrees/worktreeRemovalState';
import { buildSessionRootIndex, buildSidebarWorkIndex, buildWorktreeArchiveAnchors, isGroupWork, orderInWorkWorks, orderSidebarWorks, type SidebarWorkRef } from '../works/sidebarWorks';
import { getSessionLifecycleOrderValue } from '@/sync/session-ordering';
import { useSessionDraftsStore, type SessionDraft } from '@/stores/useSessionDraftsStore';
import { useSidebarGroupStatus } from './useSidebarGroupStatus';
import { getSessionFolderOwnerKey, getSessionFolderScopes } from '../sessions/sessionFolderIdentity';
import { SessionRowOrderProvider } from '../sessions/sessionRowOrder';
import { canRequestNativeDirectoryAccess } from '@/lib/desktop';
import { useSidebarSpaces, useSpacesStore, type SpaceMark } from '@/lib/spaces/spaces-store';
import { spaceOfCreationRequest } from '@/lib/spaces/space-creation-requests';
import { useUIStore } from '@/stores/useUIStore';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { isSessionPinned } from '@/lib/sessionPins';
import { buildMultiRunIndex } from '@/lib/multirun/runs';
import { useI18n } from '@/lib/i18n';

// A branch without a live change request is asked again when something could
// have opened one: an agent turn finishing in its directory (at once), or the
// user coming back to the window (when its answer is older than this).
const SIDEBAR_MISSING_CHANGE_REQUEST_RETURN_MS = 60_000;

// A stable empty array: without a chats group the sections hook must not see a
// new reference on every render.
const EMPTY_STANDALONE_GROUPS: SessionGroup[] = [];

const EMPTY_ZONE_ITEMS: ReturnType<typeof deriveTimelineActivityItems> = [];
const EMPTY_WORK_ENTRIES: readonly SessionSidebarWorkEntry[] = [];
const EMPTY_IDS: ReadonlySet<string> = new Set();
const NO_DRAFTS: readonly SessionDraft[] = [];
/** Pinned root sessions, and the works In work lists. */
type ZoneWorks = { pinned: readonly Session[]; pinnedWorktrees: readonly SidebarWorkRef[]; work: readonly SidebarWorkRef[] };
const EMPTY_ZONE_WORKS: ZoneWorks = { pinned: [], pinnedWorktrees: [], work: [] };

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
    projectSortOrder: import('@/stores/useSessionDisplayStore').ProjectSortOrder;
    emptyState: React.ReactNode;
    searchEmptyState: React.ReactNode;
    isSessionsLoading: boolean;
    isWorktreeTopologyLoading: boolean;
    unresolvedWorktreeProjectPaths: ReadonlySet<string>;
    projectView: ReturnType<typeof useSessionProjectViewState>['state'];
    /**
     * The match count belongs in the sidebar header, which renders above this
     * list, while only the list knows what matched. Reported upwards rather
     * than recomputed there, so the number and the rows can never disagree.
     */
    onSearchMatchCountChange: (count: number) => void;
    /** Draws the list in place of the desktop's scroller: the phone's rows over the same model. */
    renderList?: (props: SessionProjectListProps) => React.ReactNode;
  };
  actions: {
    rowActions: {
      allowReselect: boolean;
      onSessionSelected?: (sessionId: string) => void;
      resetSessionSearch: () => void;
    };
    alwaysShowActions: boolean;
    setActiveProjectIdOnly: (id: string) => void;
    setSessionSwitcherOpen: (open: boolean) => void;
    openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; preserveDirectoryOverride?: boolean }) => void;
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
      'toggleGroup' | 'toggleWork' | 'toggleProject' | 'setCollapsedActivities'
    >;
  };
};

const VisibleSessionProjects: React.FC<SessionProjectCollectionProps> = ({ topology, view, actions }) => {
  const { t } = useI18n();
  const { alwaysShowActions, projectViewActions, rowActions, ...scrollerActions } = actions;
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const collapsedFolderIds = useSessionFoldersStore((state) => state.collapsedFolderIds);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const projectView = view.projectView;
  const { toggleGroup, toggleWork, toggleProject, setCollapsedActivities } = projectViewActions;
  const collection = useSessionProjectCollection({ knownDirectories: topology.knownDirectories, isVSCode: topology.isVSCode, isVisible: true });
  const authoritativeProjects = useGlobalSyncStore((state) => state.projects);
  const spaceList = useSidebarSpaces();
  // Zone rows label a space session with the space's name where a worktree session shows its branch.
  const spaceLabelById = React.useMemo(() => new Map(spaceList.map((space) => [space.id, space.name])), [spaceList]);
  // The spaces being made or running: one nobody has chatted in yet leads its project's list.
  const spacesJourney = useSpacesStore((state) => state.journey);
  const liveSpaceIds = React.useMemo(() => new Set(
    [...(spacesJourney?.values() ?? [])].flatMap((entry) => (entry.state === 'preparing' || entry.state === 'running' ? [entry.id] : [])),
  ), [spacesJourney]);
  const spacesByProject = React.useMemo(() => {
    const byProject = new Map<string, SpaceMark[]>();
    for (const space of spaceList) {
      const projectRoot = normalizePath(space.projectDirectory);
      if (!projectRoot) continue;
      const list = byProject.get(projectRoot);
      if (list) list.push(space);
      else byProject.set(projectRoot, [space]);
    }
    return byProject;
  }, [spaceList]);
  const ownership = React.useMemo(
    () => createSessionOwnershipIndex(collection.sessions, topology.projects, topology.availableWorktreesByProject, topology.isVSCode, collection.archivedSessions, authoritativeProjects, spaceList),
    [authoritativeProjects, collection.archivedSessions, collection.sessions, spaceList, topology.availableWorktreesByProject, topology.isVSCode, topology.projects],
  );
  const [visibleSessionCountByGroup, setVisibleSessionCountByGroup] = React.useState<Map<string, number>>(new Map());
  const [visibleActivityCountByKey, setVisibleActivityCountByKey] = React.useState<Map<string, number>>(new Map());
  const showMoreGroupSessions = React.useCallback((groupId: string, currentVisibleCount: number, increment = 7) => {
    setVisibleSessionCountByGroup((current) => new Map(current).set(groupId, currentVisibleCount + increment));
  }, []);
  const resetGroupSessionLimit = React.useCallback((groupId: string) => {
    setVisibleSessionCountByGroup((current) => {
      if (!current.has(groupId)) return current;
      const next = new Map(current);
      next.delete(groupId);
      return next;
    });
  }, []);
  // A collapsed project or worktree group forgets its Show more: expanding it
  // again starts from the first page, however it was collapsed (its header,
  // Collapse all). Covers the groups, whose keys are `${projectId}:${groupId}`.
  React.useEffect(() => {
    setVisibleSessionCountByGroup((current) => {
      if (current.size === 0) return current;
      const isCollapsedKey = (key: string): boolean => (
        projectView.collapsedGroups.has(key)
        || [...projectView.collapsedProjects].some((projectId) => key.startsWith(`${projectId}:`))
      );
      const stale = [...current.keys()].filter(isCollapsedKey);
      if (stale.length === 0) return current;
      const next = new Map(current);
      for (const key of stale) next.delete(key);
      return next;
    });
  }, [projectView.collapsedGroups, projectView.collapsedProjects]);
  const showChatsSection = useSessionDisplayStore((state) => state.showChatsSection);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const singleProjectId = useSessionDisplayStore((state) => state.singleProjectId);
  const setSingleProjectId = useSessionDisplayStore((state) => state.setSingleProjectId);
  const supportsSingleProjectMode = !topology.isVSCode && !isCapacitorApp();
  const singleProjectMode = supportsSingleProjectMode && projectDisplayMode === 'single';
  // VS Code lists every session under its workspace and keeps sessions in
  // work there too; it has neither the list by time nor worktree works.
  const sidebarGrouping = useSessionDisplayStore(resolveSidebarGrouping);
  const keepWorkInPlaceSetting = useSessionDisplayStore((state) => state.keepWorkInPlace);
  const timeGrouping = !topology.isVSCode && sidebarGrouping === 'time';
  const keepWorkInPlace = topology.isVSCode || keepWorkInPlaceSetting;
  const runIndex = React.useMemo(() => buildMultiRunIndex(
    collection.rootSessions,
    (session) => normalizePath(topology.worktreeMetadata.get(session.id)?.projectDirectory ?? session.directory ?? null),
  ), [collection.rootSessions, topology.worktreeMetadata]);
  // Grouping only needs membership. Keeping the map stable while membership is
  // unchanged keeps every project section cached across ordinary updates.
  const runMembershipRef = React.useRef<{ signature: string; map: ReadonlyMap<string, string> } | null>(null);
  const runKeyBySessionId = React.useMemo(() => {
    const signature = Array.from(runIndex.runKeyBySessionId, ([id, key]) => `${id}\u0000${key}`).sort().join('\u0001');
    if (runMembershipRef.current?.signature !== signature) {
      runMembershipRef.current = { signature, map: runIndex.runKeyBySessionId };
    }
    return runMembershipRef.current.map;
  }, [runIndex]);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingRowKey, setEditingRowKey] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [openSidebarMenuKey, setOpenSidebarMenuKey] = React.useState<string | null>(null);
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<DeleteSessionConfirmState>(null);
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
  const { buildGroupedSessions, getGroupingSessions, filterSessionNodesForSearch, buildGroupSearchText } = useSessionGrouping({
    homeDirectory: view.homeDirectory,
    worktreeMetadata: topology.worktreeMetadata,
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderRanks: collection.sessionOrderRanks,
    gitBranches: topology.gitBranches,
    isVSCode: topology.isVSCode,
    sessionById: collection.sessionById,
    childrenMap: collection.childrenMap,
    nestedSessionIds: collection.nestedSessionIds,
    sessionOwners: ownership.bySessionId,
    spacesByProject,
    runKeyBySessionId,
  });
  const { getSessionsForProject, getArchivedSessionsForProject } = useProjectSessionLists({ ownership });
  const knownChatsRoot = useChatsRoot();
  // Built before the sections hook runs, because that hook owns the search data
  // for every group the sidebar renders — the chats group included. A group the
  // hook never sees renders an empty list while a search is active.
  const chatGroup = React.useMemo<SessionGroup | null>(() => {
    if (topology.isVSCode && !isVSCodeWithoutWorkspace()) return null;
    const chatsRoot = knownChatsRoot
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
        .filter((session) => !session.time?.archived && !collection.nestedSessionIds.has(session.id))
        .map((session) => buildActiveSessionNode(collection.childrenMap, session)),
    };
  }, [collection.chatSessions, collection.childrenMap, collection.nestedSessionIds, knownChatsRoot, topology.isVSCode]);
  const archivedChatGroup = React.useMemo<SessionGroup | null>(() => {
    if (!chatGroup || !topology.isVSCode || !view.showInlineArchived) return null;
    const sessions = collection.archivedSessions
      .filter((session) => isChatDirectoryPath(session.directory) && !session.parentID)
      .map((session) => ({ session, children: [], worktree: null }));
    if (sessions.length === 0) return null;
    return { ...chatGroup, id: 'managed-chats-archived', label: t('sessions.sidebar.grouping.archived'), isMain: false, isArchivedBucket: true, directory: null, folderScopeKey: null, sessions, folderScopes: [] };
  }, [chatGroup, collection.archivedSessions, t, topology.isVSCode, view.showInlineArchived]);
  const standaloneGroups = React.useMemo<SessionGroup[]>(
    () => chatGroup ? [chatGroup, ...(archivedChatGroup ? [archivedChatGroup] : [])] : EMPTY_STANDALONE_GROUPS,
    [archivedChatGroup, chatGroup],
  );
  const { projectSections, groupSearchDataByGroup, sectionsForRender, flatSectionsForRender } = useSessionSidebarSections({
    normalizedProjects: topology.projects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject: topology.availableWorktreesByProject,
    projectRepoStatus: topology.projectRepoStatus,
    projectRootBranches: topology.projectRootBranches,
    gitBranches: topology.gitBranches,
    sessionOrderRanks: collection.sessionOrderRanks,
    lastRepoStatus: topology.lastRepoStatus,
    buildGroupedSessions,
    getGroupingSessions,
    hasSessionSearchQuery: view.hasSessionSearchQuery,
    normalizedSessionSearchQuery: view.normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    foldersMap,
    standaloneGroups,
  });

  const onSearchMatchCountChange = view.onSearchMatchCountChange;
  // Unmounting means nothing is listed any more, so the header must not keep
  // showing the last count it was told about.
  React.useEffect(() => () => onSearchMatchCountChange(0), [onSearchMatchCountChange]);

  const childStores = useChildStoreManager();
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
  const { sourceControl } = useRuntimeAPIs();
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshPrStatusTargets = useGitHubPrStatusStore((state) => state.refreshTargets);
  const clearDirectoryStatus = useGitHubPrStatusStore((state) => state.clearDirectoryStatus);
  const beginActiveSourceControlContextsLoad = useGitHubPrStatusStore((state) => state.beginActiveContextsLoad);
  const commitActiveSourceControlContexts = useGitHubPrStatusStore((state) => state.commitActiveContexts);
  const releaseActiveSourceControlContexts = useGitHubPrStatusStore((state) => state.releaseActiveContexts);
  const activeContextRegistrations = useGitHubPrStatusStore((state) => state.activeContextRegistrations);
  const sourceControlContextsOwnerId = React.useId();
  const retriedMissingChangeRequestKeysRef = React.useRef<Set<string>>(new Set());
  const registeredContextDirectoriesRef = React.useRef<RegisteredContextDirectories>(new Map());
  const sessionOrderIndex = React.useMemo(
    () => new Map(collection.orderedSessions.map((session, index) => [session.id, index])),
    [collection.orderedSessions],
  );
  // While the pointer is over the list, "Recent" keeps the order the user is
  // looking at: a session finishing elsewhere must not move the row under
  // the cursor. Leaving the list applies the live order.
  const [heldProjectOrder, setHeldProjectOrder] = React.useState<readonly string[] | null>(null);
  const shownProjectOrderRef = React.useRef<readonly string[]>([]);
  const holdsProjectOrder = view.projectSortOrder === 'recent';
  React.useEffect(() => {
    if (!holdsProjectOrder) setHeldProjectOrder(null);
  }, [holdsProjectOrder]);
  const orderedSectionsForRender = React.useMemo(() => {
    // "Recent" needs the sessions, which only exist from here on.
    const ranked = rankByLatestActivity(sectionsForSidebarRender, view.projectSortOrder, (section) => section.project.id, ownership.sessionsByProject);
    return [...(heldProjectOrder && holdsProjectOrder ? holdOrder(ranked, heldProjectOrder, (section) => section.project.id) : ranked)];
  }, [heldProjectOrder, holdsProjectOrder, ownership.sessionsByProject, sectionsForSidebarRender, view.projectSortOrder]);
  React.useEffect(() => {
    shownProjectOrderRef.current = orderedSectionsForRender.map((section) => section.project.id);
  }, [orderedSectionsForRender]);
  // Pinned sessions: top-level, unarchived project sessions (Chats keep their
  // pins in Chats), in the shared lifecycle order; while the Pinned zone
  // lists them they leave their project. Works in work: a session work when its root or any session
  // nested under it is in work, a worktree work when any of its sessions is.
  // A work whose root session is pinned is listed in Pinned only.
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const showWorkSection = useSessionDisplayStore((state) => state.showWorkSection);
  const showPinnedSection = useSessionDisplayStore((state) => state.showPinnedSection);
  const detailedZoneRows = useSessionDisplayStore((state) => state.detailedZoneRows);
  const workIndex = React.useMemo(() => buildSidebarWorkIndex(projectSections), [projectSections]);
  const worktreeArchiveAnchors = React.useMemo(() => buildWorktreeArchiveAnchors({
    groupWorks: workIndex.groupWorks,
    archivedSessions: collection.archivedSessions,
    orderedSessions: collection.orderedSessions,
    orderValueOf: (session) => getSessionLifecycleOrderValue(session, collection.sessionOrderRanks),
    isPinned: (session) => isSessionPinned(collection.pinnedSessionIds, session.directory, session.id),
  }), [collection.archivedSessions, collection.orderedSessions, collection.pinnedSessionIds, collection.sessionOrderRanks, workIndex]);
  const rootSessionIds = React.useMemo(() => new Set(collection.rootSessions.map((session) => session.id)), [collection.rootSessions]);
  const sessionRootIndex = React.useMemo(
    () => buildSessionRootIndex(collection.rootSessions, collection.childrenMap),
    [collection.childrenMap, collection.rootSessions],
  );
  // Drafts of new sessions not sent yet, where their session would go: a
  // worktree's in its group, the project root's at the top of the project. The
  // open one stays listed (selected) until it is sent or thrown away; a draft
  // with nothing typed yet is not stored and has no row.
  const storedDrafts = useSessionDraftsStore((state) => (state.runtimeKey === getRuntimeKey() ? state.drafts : NO_DRAFTS));
  const openDraftDirectory = useSessionUIStore((state) => (
    !state.currentSessionId && state.newSessionDraft.open && state.newSessionDraft.target === 'project'
      ? normalizePath(state.newSessionDraft.directoryOverride ?? null)
      : null
  ));
  // The space the open draft waits for while it is being made.
  const openDraftSpaceId = useSessionUIStore((state) => (
    !state.currentSessionId && state.newSessionDraft.open ? spaceOfCreationRequest(state.newSessionDraft.pendingWorktreeRequestId) : null
  ));
  const draftPlacement = React.useMemo(() => {
    const byGroupKey = new Map<string, SessionDraft[]>();
    const rootDrafts: Array<{ draft: SessionDraft; projectId: string }> = [];
    if (topology.isVSCode) return { byGroupKey, rootDrafts };
    const drafts = [...storedDrafts].sort((left, right) => right.updatedAt - left.updatedAt);
    for (const draft of drafts) {
      const directory = normalizePath(draft.directory);
      if (!directory) continue;
      // The draft's own project first; otherwise the project whose folder
      // holds it most closely, as nested projects share a prefix.
      const section = projectSections.find((entry) => entry.project.id === draft.projectId)
        ?? projectSections
          .filter((entry) => isPathWithinProject(directory, entry.project.normalizedPath))
          .sort((left, right) => right.project.normalizedPath.length - left.project.normalizedPath.length)[0];
      if (!section) continue;
      const worktreeGroup = section.groups.find((group) => isGroupWork(group) && isPathWithinProject(directory, group.directory));
      const group = worktreeGroup ?? section.groups.find((entry) => entry.isMain);
      if (!group) continue;
      const groupKey = `${section.project.id}:${group.id}`;
      byGroupKey.set(groupKey, [...(byGroupKey.get(groupKey) ?? []), draft]);
      if (!worktreeGroup) rootDrafts.push({ draft, projectId: section.project.id });
    }
    return { byGroupKey, rootDrafts };
  }, [projectSections, storedDrafts, topology.isVSCode]);
  const removingWorktreePaths = useRemovingWorktreePaths();
  // The works the block listed last time, in order (see the removal case below).
  const lastWorkKeysRef = React.useRef<readonly string[]>([]);
  const zoneWorks = React.useMemo((): ZoneWorks => {
    const showWork = sessionWorkEnabled && showWorkSection;
    if (!showWork && !showPinnedSection) return EMPTY_ZONE_WORKS;
    const pinned = showPinnedSection
      ? collection.orderedSessions.filter((session) => rootSessionIds.has(session.id)
        && !session.time?.archived
        && !isChatDirectoryPath(session.directory)
        && isSessionPinned(collection.pinnedSessionIds, session.directory, session.id))
      : [];
    const pinnedIds = new Set(pinned.map((session) => session.id));
    // Pinned worktrees follow the pinned sessions, the latest pin first.
    const pinnedWorktrees = showPinnedSection
      ? workIndex.groupWorks
        .filter((ref) => ref.group.worktree?.pinnedAt !== undefined)
        .sort((left, right) => (right.group.worktree?.pinnedAt ?? 0) - (left.group.worktree?.pinnedAt ?? 0))
      : [];
    const pinnedKeys = new Set(pinnedWorktrees.map((ref) => ref.key));
    const work = showWork
      ? orderInWorkWorks(collection.orderedSessions, workIndex, sessionRootIndex, isChatDirectoryPath)
        .filter((ref) => (ref.kind === 'session' ? !pinnedIds.has(ref.rootSessionId) : !pinnedKeys.has(ref.key)))
      : [];
    // A worktree or a space with no session yet is in work while a draft is
    // begun there: the user just made it for a task. It opens the block, as
    // the newest. A space's draft waits on the project root while the space
    // is made, and names it by its creation request.
    const begun = showWork
      ? workIndex.groupWorks.filter((ref) => ref.group.sessions.length === 0 && !pinnedKeys.has(ref.key) && !work.some((entry) => entry.key === ref.key) && (
        draftPlacement.byGroupKey.has(ref.key)
        || Boolean(openDraftDirectory && isPathWithinProject(openDraftDirectory, normalizePath(ref.group.directory ?? null)))
        || Boolean(openDraftSpaceId && ref.group.space?.id === openDraftSpaceId)
      ))
      : [];
    const listed = [...begun, ...work];
    // A worktree being removed keeps its place until git is done: archiving
    // its sessions first must not drop it from the block mid-removal.
    if (showWork && removingWorktreePaths.size > 0) {
      const listedKeys = new Set(listed.map((ref) => ref.key));
      lastWorkKeysRef.current.forEach((key, index) => {
        if (listedKeys.has(key)) return;
        const ref = workIndex.groupWorks.find((entry) => entry.key === key);
        const path = normalizePath(ref?.group.directory ?? null);
        if (ref && path && removingWorktreePaths.has(path)) listed.splice(Math.min(index, listed.length), 0, ref);
      });
    }
    if (pinned.length === 0 && pinnedWorktrees.length === 0 && listed.length === 0) return EMPTY_ZONE_WORKS;
    return { pinned, pinnedWorktrees, work: listed };
  }, [collection.orderedSessions, collection.pinnedSessionIds, draftPlacement, openDraftDirectory, openDraftSpaceId, removingWorktreePaths, rootSessionIds, sessionRootIndex, sessionWorkEnabled, showPinnedSection, showWorkSection, workIndex]);
  React.useEffect(() => {
    lastWorkKeysRef.current = zoneWorks.work.map((ref) => ref.key);
  }, [zoneWorks]);
  // Worktree works start folded (`isWorkExpanded`); the row model reads one
  // set of folded groups, so theirs join the groups' own.
  const worktreeWorkKeys = React.useMemo(() => new Set(workIndex.groupWorks.map((ref) => ref.key)), [workIndex]);
  const collapsedGroups = React.useMemo(() => {
    if (worktreeWorkKeys.size === 0) return projectView.collapsedGroups;
    const next = new Set(projectView.collapsedGroups);
    for (const key of worktreeWorkKeys) {
      if (isWorkExpanded(projectView.workExpansion, key)) next.delete(key);
      else next.add(key);
    }
    return next;
  }, [projectView.collapsedGroups, projectView.workExpansion, worktreeWorkKeys]);
  const toggleGroupOrWork = React.useCallback((key: string) => {
    if (worktreeWorkKeys.has(key)) toggleWork(key);
    else toggleGroup(key);
  }, [toggleGroup, toggleWork, worktreeWorkKeys]);
  const workSessions = React.useMemo(
    () => zoneWorks.work.length === 0 ? [] : collection.orderedSessions.filter((session) => (
      !session.parentID && !session.time?.archived && !isChatDirectoryPath(session.directory) && isSessionInWork(session)
    )),
    [collection.orderedSessions, zoneWorks.work.length],
  );
  // The root sessions the zones list, which search lists there only.
  const zoneSessionIds = React.useMemo(() => new Set([
    ...zoneWorks.pinned.map((session) => session.id),
    ...zoneWorks.work.flatMap((ref) => ref.kind === 'session' ? [ref.rootSessionId] : []),
  ]), [zoneWorks]);
  const buildZoneItems = React.useCallback((zone: readonly Session[]) => {
    if (zone.length === 0) return EMPTY_ZONE_ITEMS;
    const locations = resolveSidebarSessionLocations({
      sessions: [...zone],
      projects: topology.projects,
      ownerBySessionId: ownership.bySessionId,
      spaceLabelById,
      availableWorktreesByProject: topology.availableWorktreesByProject,
      gitBranches: topology.gitBranches,
      homeDirectory: view.homeDirectory,
      rootBranchByProjectId: topology.projectRootBranches,
      hideBranchMatchingProjectLabel: false,
    });
    const query = view.hasSessionSearchQuery ? view.normalizedSessionSearchQuery : '';
    const trees = new Map(zone.map((session) => [session.id, buildActiveSessionNode(collection.childrenMap, session)]));
    const nodes = new Map(zone.map((session) => {
      const tree = trees.get(session.id) ?? buildActiveSessionNode(collection.childrenMap, session);
      const worktree = locations.get(session.id)?.worktree ?? null;
      // Zone rows open to what is nested under them, like the project tree,
      // and a search shows the branches that lead to a match.
      const shown = query ? pruneSessionTreeForSidebarQuery(tree, query) ?? tree : tree;
      return [session.id, { ...shown, worktree }];
    }));
    const matched = matchZoneSessionsForSidebarQuery(
      zone,
      (session) => trees.get(session.id) ?? buildActiveSessionNode(collection.childrenMap, session),
      query,
      'tree',
    );
    const items = deriveTimelineActivityItems({
      sessions: matched.sessions,
      getSessionLocation: (sessionId) => locations.get(sessionId) ?? null,
      getSessionNode: (session) => nodes.get(session.id) ?? buildActiveSessionNode(collection.childrenMap, session),
      query: '',
    });
    // The search count comes from the match: the project subtracts every
    // match in a tree that moved here. A row works its badges out from its
    // own expansion.
    return items.map((item) => ({
      ...item,
      searchMatchCount: matched.matchCountById.get(item.node.session.id),
    }));
  }, [collection.childrenMap, ownership.bySessionId, spaceLabelById, topology.availableWorktreesByProject, topology.gitBranches, topology.projectRootBranches, topology.projects, view.hasSessionSearchQuery, view.homeDirectory, view.normalizedSessionSearchQuery]);
  // Works as the row model lists them: a session work's row from the zone
  // items (search may have left it out), a worktree work as its group.
  const toWorkEntries = React.useCallback((refs: readonly SidebarWorkRef[]): readonly SessionSidebarWorkEntry[] => {
    if (refs.length === 0) return EMPTY_WORK_ENTRIES;
    const roots = refs.flatMap((ref) => {
      if (ref.kind !== 'session') return [];
      const session = collection.sessionById.get(ref.rootSessionId);
      return session ? [session] : [];
    });
    const itemById = new Map(buildZoneItems(roots).map((item) => [item.node.session.id, item]));
    return refs.flatMap((ref): SessionSidebarWorkEntry[] => {
      if (ref.kind === 'group') return [{ kind: 'group', groupKey: ref.key, projectId: ref.projectId, group: ref.group }];
      const item = itemById.get(ref.rootSessionId);
      return item ? [{ kind: 'session', item }] : [];
    });
  }, [buildZoneItems, collection.sessionById]);
  const pinnedItems = React.useMemo(() => buildZoneItems(zoneWorks.pinned), [buildZoneItems, zoneWorks.pinned]);
  const pinnedWorktreeEntries = React.useMemo(() => toWorkEntries(zoneWorks.pinnedWorktrees), [toWorkEntries, zoneWorks.pinnedWorktrees]);
  const workEntries = React.useMemo(() => toWorkEntries(zoneWorks.work), [toWorkEntries, zoneWorks.work]);
  // Grouped by time: the spaces nobody has chatted in yet, every other work of
  // every project, most recent first, then the worktrees nobody has started a
  // session in yet.
  const timeEntries = React.useMemo((): readonly SessionSidebarWorkEntry[] | null => {
    if (!timeGrouping) return null;
    const listedKeys = new Set([...zoneWorks.work, ...zoneWorks.pinnedWorktrees].map((ref) => ref.key));
    for (const session of zoneWorks.pinned) listedKeys.add(`session:${session.id}`);
    const refs = orderSidebarWorks(collection.orderedSessions, workIndex, (session) => (
      !session.time?.archived && !isChatDirectoryPath(session.directory)
    ), worktreeArchiveAnchors).filter((ref) => !listedKeys.has(ref.key));
    const seen = new Set(refs.map((ref) => ref.key));
    // Works nobody has started a session in: worktrees close the list, spaces
    // lead it, as in a project's list (`mergeWorktreeEntries`).
    const unstarted = workIndex.groupWorks.filter((ref) => !seen.has(ref.key) && !listedKeys.has(ref.key));
    const leads = (ref: SidebarWorkRef): boolean => ref.kind === 'group' && Boolean(ref.group.space && liveSpaceIds.has(ref.group.space.id));
    refs.unshift(...unstarted.filter(leads));
    refs.push(...unstarted.filter((ref) => !leads(ref)));
    // A pinned worktree still listed here (the Pinned section is hidden)
    // leads the list, as pinned sessions do in the lifecycle order.
    const isPinnedWorktree = (ref: SidebarWorkRef): boolean => ref.kind === 'group' && ref.group.worktree?.pinnedAt !== undefined;
    // New works the user has only drafted open the list.
    return [
      ...draftPlacement.rootDrafts.map(({ draft, projectId }): SessionSidebarWorkEntry => ({ kind: 'draft', draft, projectId })),
      ...toWorkEntries([...refs.filter(isPinnedWorktree), ...refs.filter((ref) => !isPinnedWorktree(ref))]),
    ];
  }, [collection.orderedSessions, draftPlacement, liveSpaceIds, timeGrouping, toWorkEntries, workIndex, worktreeArchiveAnchors, zoneWorks]);
  // What leaves its project for the zones. A pinned work always does: the
  // Pinned zone is shown only by choice, and then the work is there. A work
  // in work leaves unless kept in place by choice, and still leaves during a
  // search, which lists each match once.
  const movesWorkOut = !keepWorkInPlace || view.hasSessionSearchQuery;
  const movedSessionIds = React.useMemo(() => {
    const ids = zoneWorks.pinned.map((session) => session.id);
    if (movesWorkOut) {
      for (const ref of zoneWorks.work) if (ref.kind === 'session') ids.push(ref.rootSessionId);
    }
    return ids.length > 0 ? new Set(ids) : EMPTY_IDS;
  }, [movesWorkOut, zoneWorks]);
  const movedGroupKeys = React.useMemo(() => {
    const keys = zoneWorks.pinnedWorktrees.map((ref) => ref.key);
    if (movesWorkOut) {
      for (const ref of zoneWorks.work) if (ref.kind === 'group') keys.push(ref.key);
    }
    return keys.length > 0 ? new Set(keys) : EMPTY_IDS;
  }, [movesWorkOut, zoneWorks.pinnedWorktrees, zoneWorks.work]);
  // Branches whose PR badge is on screen: the works in Pinned and In work,
  // then the list by time or the expanded projects.
  const urlMatcher = useRepositoryUrlMatcher();
  const shownPrs = React.useMemo(() => {
    const targets = new Map<string, { directory: string; branch: string }>();
    // Change requests and issues linked to the sessions on screen, whatever
    // their branch; their state comes from their instance.
    const repositoryRefs = new Map<string, RepositoryThreadRef>();
    // Tracker items linked to the sessions on screen, by tracker and
    // identifier; their state comes from their tracker, on its own cadence.
    const trackerItems = new Map<string, { provider: string; identifier: string }>();
    const addTarget = (directory: string | null, branch: string | null | undefined) => {
      const trimmed = branch?.trim();
      if (directory && trimmed) targets.set(getGitHubPrStatusKey(directory, trimmed), { directory, branch: trimmed });
    };
    // Same pair a row derives its badge key from (resolveSessionPrLookupKey).
    const addNode = (node: SessionNode) => {
      addTarget(normalizePath(node.worktree?.path ?? null), node.worktree?.branch);
      if (!topology.isVSCode) {
        for (const change of getLinkedSidebarChanges(node.session, urlMatcher)) {
          if (change.repository) repositoryRefs.set(change.repository.key, change.repository);
        }
        for (const issue of getLinkedSidebarIssues(node.session, urlMatcher)) {
          if (issue.source === 'repository') repositoryRefs.set(issue.ref.key, issue.ref);
          else if (issue.source === 'tracker') {
            const identifier = issue.identifier.toUpperCase();
            trackerItems.set(`${issue.provider}|${identifier}`, { provider: issue.provider, identifier });
          }
        }
      }
      node.children.forEach(addNode);
    };
    // A worktree work's group row shows its branch PR; its sessions show the
    // PRs and issues linked to them.
    const addGroup = (group: SessionGroup) => {
      group.sessions.forEach(addNode);
      if (group.isMain || group.isArchivedBucket) return;
      const directory = normalizePath(group.directory ?? null);
      addTarget(directory, group.branch?.trim() || topology.gitBranches.get(directory || ''));
    };
    const addEntry = (entry: SessionSidebarWorkEntry) => {
      if (entry.kind === 'session') addNode(entry.item.node);
      else if (entry.kind === 'group') addGroup(entry.group);
    };
    pinnedItems.forEach((item) => addNode(item.node));
    pinnedWorktreeEntries.forEach(addEntry);
    if (!projectView.collapsedActivities.has('work')) workEntries.forEach(addEntry);
    if (timeEntries) {
      if (!projectView.collapsedActivities.has('timeline')) timeEntries.forEach(addEntry);
      return { targets, repositoryRefs: [...repositoryRefs.values()], trackerItems: [...trackerItems.values()] };
    }
    projectSections.forEach((section) => {
      if (projectView.collapsedProjects.has(section.project.id)) return;
      section.groups.forEach((group) => {
        if (!group.isArchivedBucket) addGroup(group);
      });
    });
    return { targets, repositoryRefs: [...repositoryRefs.values()], trackerItems: [...trackerItems.values()] };
  }, [pinnedItems, pinnedWorktreeEntries, projectSections, projectView.collapsedActivities, projectView.collapsedProjects, timeEntries, topology.gitBranches, topology.isVSCode, urlMatcher, workEntries]);
  const shownPrTargets = shownPrs.targets;
  // The discovery effect below subscribes to bindings and reads them; keep its
  // input stable while the shown branches are the same, so ordinary sidebar
  // updates do not restart it.
  const discoveryCandidatesRef = React.useRef<{ signature: string; candidates: Array<{ directory: string; branch: string }> } | null>(null);
  const discoveryCandidates = React.useMemo(() => {
    const candidates = limitSourceControlDiscoveryCandidates(shownPrTargets.values());
    const signature = JSON.stringify(candidates);
    if (discoveryCandidatesRef.current?.signature !== signature) {
      discoveryCandidatesRef.current = { signature, candidates };
    }
    return discoveryCandidatesRef.current.candidates;
  }, [shownPrTargets]);
  // Discover/refresh change-request status for the shown worktree branches so
  // rows can tint their branch marker and show state in tooltips: from a
  // branch with no change request yet, or one closed/merged (a newer one may
  // have opened). Each directory is read with the account its repository
  // binding names. Open change requests stay live through the batched
  // summaries below instead.
  React.useEffect(() => {
    const candidates = discoveryCandidates;
    const discoveryRuntimeKey = getRuntimeKey();
    const isCurrent = captureRuntimeInstance();
    const candidateDirectories = new Set(candidates.map((candidate) => candidate.directory));
    reconcileRegisteredContextDirectories(
      registeredContextDirectoriesRef.current,
      discoveryRuntimeKey,
      candidateDirectories,
      (runtimeKey, directory) => releaseActiveSourceControlContexts(runtimeKey, directory, sourceControlContextsOwnerId),
    );
    if (candidates.length === 0) return;

    let cancelled = false;
    const discover = async (changedDirectory?: string, retryAfterMs = SIDEBAR_MISSING_CHANGE_REQUEST_RETURN_MS) => {
      if (cancelled || !isCurrent()) return;
      const now = Date.now();
      const contextsByDirectory = new Map<string, Promise<SourceControlReadContext[] | null>>();
      const loadContexts = (directory: string): Promise<SourceControlReadContext[] | null> => {
        const pending = contextsByDirectory.get(directory);
        if (pending) return pending;
        const contextRequestId = beginActiveSourceControlContextsLoad(
          discoveryRuntimeKey,
          directory,
          sourceControlContextsOwnerId,
        );
        const scope = repositoryBindingOwner.scope(directory);
        const loading = runBackgroundNetworkTask(() => repositoryBindingOwner.read(scope, sourceControl)).then((load) => {
          if (!load || cancelled || !isCurrent()) return null;
          const primaryContext = load.contexts[0];
          const contexts = primaryContext && getSourceControlReadContextAuthState(
            useSourceControlAuthStore.getState().entries[getSourceControlAuthKey(primaryContext)],
            primaryContext,
          ).connected ? [primaryContext] : [];
          const accepted = commitActiveSourceControlContexts(
            discoveryRuntimeKey,
            directory,
            sourceControlContextsOwnerId,
            contextRequestId,
            contexts,
          );
          if (!accepted) return null;
          if (contexts.length === 0) clearDirectoryStatus(directory);
          return contexts;
        });
        contextsByDirectory.set(directory, loading);
        return loading;
      };
      const resolvedTargets = await Promise.all(candidates
        .filter((candidate) => !changedDirectory || candidate.directory === changedDirectory)
        .map(async (candidate) => {
          const contexts = await loadContexts(candidate.directory);
          return (contexts ?? []).map((context) => ({ ...candidate, context }));
        }));

      if (cancelled || !isCurrent()) return;

      type DiscoveryTarget = { context: SourceControlReadContext; branch: string };
      const targetsByKey = new Map<string, DiscoveryTarget>();
      const activeTargetsByKey = new Map<string, DiscoveryTarget>();
      for (const target of resolvedTargets.flat()) {
        const key = getSourceControlStatusKey(target.context, target.branch);
        activeTargetsByKey.set(key, { context: target.context, branch: target.branch });
        const entry = useGitHubPrStatusStore.getState().entries[key];
        const changeRequest = entry?.status?.changeRequest ?? entry?.status?.pr;
        const changeRequestState = changeRequest?.state;
        const isTerminalChangeRequest = changeRequestState === 'closed' || changeRequestState === 'merged';
        // Closed/merged associations are not live branch status — retry them on
        // the same cadence as missing change requests so a newer one can appear.
        const hasLiveChangeRequest = Boolean(changeRequest) && !isTerminalChangeRequest;
        const lastCheckedAt = Math.max(entry?.lastRefreshAt ?? 0, entry?.lastDiscoveryPollAt ?? 0);
        const shouldRetryMissingChangeRequest = Boolean(
          entry?.isInitialStatusResolved
          && !hasLiveChangeRequest
          && (
            !retriedMissingChangeRequestKeysRef.current.has(key)
            || now - lastCheckedAt >= retryAfterMs
          ),
        );
        if (!entry || !entry.isInitialStatusResolved || shouldRetryMissingChangeRequest) {
          if (shouldRetryMissingChangeRequest) retriedMissingChangeRequestKeysRef.current.add(key);
          if (!targetsByKey.has(key)) targetsByKey.set(key, { context: target.context, branch: target.branch });
        }
      }

      activeTargetsByKey.forEach((target, key) => {
        ensurePrStatusEntry(key);
        setPrStatusParams(key, {
          directory: target.context.directory,
          branch: target.branch,
          remoteName: target.context.primaryRemote,
          canShow: true,
          identity: target.context,
          readContext: target.context,
          sourceControl,
          authChecked: true,
          connected: true,
        });
      });

      if (targetsByKey.size === 0) return;

      await refreshPrStatusTargets([...targetsByKey.values()], { silent: true, markInitialResolved: true });
    };

    const bindingScopes = [...new Set(candidates.map((candidate) => candidate.directory))]
      .map((directory) => repositoryBindingOwner.scope(directory));
    const releases = bindingScopes.map((scope) => {
      let previous = repositoryBindingOwner.snapshot(scope);
      return repositoryBindingOwner.subscribe(scope, () => {
        const next = repositoryBindingOwner.snapshot(scope);
        const changed = previous.read !== null && previous !== next;
        previous = next;
        if (changed && !cancelled) void discover(scope.directory);
      });
    });
    const releaseAuth = useSourceControlAuthStore.subscribe((next, previous) => {
      if (cancelled || discoveryRuntimeKey !== getRuntimeKey() || next.entries === previous.entries) return;
      for (const scope of bindingScopes) {
        const context = repositoryBindingOwner.snapshot(scope).contexts[0];
        if (!context) continue;
        const key = getSourceControlAuthKey(context);
        if (next.entries[key] !== previous.entries[key]) void discover(scope.directory);
      }
    });
    void discover();
    const releaseActivity = subscribeOpenchamberEvents((event) => {
      if (!cancelled && event.type === 'source-control-activity' && candidateDirectories.has(event.directory)) {
        void discover(event.directory, 0);
      }
    });
    const onReturn = () => {
      if (!cancelled && document.visibilityState === 'visible') void discover();
    };
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      cancelled = true;
      releaseAuth();
      releases.forEach((release) => release());
      releaseActivity();
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [
    beginActiveSourceControlContextsLoad,
    clearDirectoryStatus,
    commitActiveSourceControlContexts,
    discoveryCandidates,
    ensurePrStatusEntry,
    refreshPrStatusTargets,
    releaseActiveSourceControlContexts,
    setPrStatusParams,
    sourceControl,
    sourceControlContextsOwnerId,
  ]);
  React.useEffect(() => () => reconcileRegisteredContextDirectories(
    registeredContextDirectoriesRef.current,
    getRuntimeKey(),
    new Set(),
    (runtimeKey, directory) => releaseActiveSourceControlContexts(runtimeKey, directory, sourceControlContextsOwnerId),
  ), [releaseActiveSourceControlContexts, sourceControlContextsOwnerId]);
  // Batched summaries go to the bound entries the shown rows read.
  const shownPrKeys = React.useMemo(
    () => getActiveSourceControlStatusKeys(activeContextRegistrations, shownPrTargets.values()),
    [activeContextRegistrations, shownPrTargets],
  );
  // The open change requests of the branches on screen, and the linked PRs,
  // merge requests and issues: the server follows them and pushes changes.
  const branchPulls = useBranchTrackedPulls(shownPrKeys);
  const shownTrackedItems = React.useMemo((): TrackedItem[] => [
    ...branchPulls,
    ...shownPrs.repositoryRefs.map((ref) => repositoryThread(ref.thread, ref)),
    ...shownPrs.trackerItems.map(({ provider, identifier }) => workItem(provider, identifier)),
  ], [branchPulls, shownPrs]);
  useTrackedItems(shownTrackedItems);

  const { groupStatusByKey, bootstrapSnapshot } = useSidebarGroupStatus({
    childStores,
    sections: orderedSectionsForRender,
    chatGroup,
    canGrantAccess: canRequestNativeDirectoryAccess(),
  });
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
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderIndex,
    expandedParents,
    editingId,
    editingRowKey,
    editTitle,
    sessionBatchSize: singleProjectMode && !view.useGroupedSections ? 20 : undefined,
    setEditingId,
    setEditingRowKey,
    setEditTitle,
    toggleParent,
    allowReselect: rowActions.allowReselect,
    onSessionSelected: rowActions.onSessionSelected,
    resetSessionSearch: rowActions.resetSessionSearch,
    deleteSessionConfirm,
    setDeleteSessionConfirm,
    startFolderRename,
    startSessionWorktreeMenuLoad: actions.startSessionWorktreeMenuLoad,
    folderRename,
    setFolderRenameDraft,
    clearFolderRename,
  }), [
    collection.pinnedSessionIds,
    alwaysShowActions,
    projectView.collapsedGroups,
    groupSearchDataByGroup,
    sessionOrderIndex,
    editTitle,
    editingId,
    editingRowKey,
    expandedParents,
    folderRename,
    setFolderRenameDraft,
    clearFolderRename,
    startFolderRename,
    deleteSessionConfirm,
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
    onToggleCollapsedGroup: toggleGroupOrWork,
  }), [
    resetGroupSessionLimit,
    showMoreGroupSessions,
    toggleGroupOrWork,
    scrollerActions.openNewSessionDraft,
    scrollerActions.setActiveProjectIdOnly,
    scrollerActions.setSessionSwitcherOpen,
  ]);
  const folderAuthorityByOwner = React.useMemo(() => {
    // The snapshot is the invalidation token; childStores owns the structured state read below.
    void bootstrapSnapshot;
    const nextFolderAuthorityByOwner = new Map<string, { scopeKeys: readonly string[]; complete: boolean }>();
    for (const section of orderedSectionsForRender) {
      for (const group of section.groups) {
        const ownerKey = getSessionFolderOwnerKey(section.project.id, group.directory);
        if (!ownerKey) continue;
        const scopes = getSessionFolderScopes(group);
        const current = nextFolderAuthorityByOwner.get(ownerKey);
        const scopeKeys = [...new Set([...(current?.scopeKeys ?? []), ...scopes.map((scope) => scope.scopeKey)])];
        const complete = collection.hasAuthoritativeGlobalSessions && scopes.every((scope) => {
          const directory = normalizePath(scope.directory);
          return !directory || childStores.getBootstrapState(directory) === 'complete';
        });
        nextFolderAuthorityByOwner.set(ownerKey, { scopeKeys, complete: (current?.complete ?? true) && complete });
      }
    }
    if (chatGroup) {
      const ownerKey = getSessionFolderOwnerKey(null, chatGroup.directory);
      if (ownerKey) nextFolderAuthorityByOwner.set(ownerKey, { scopeKeys: getSessionFolderScopes(chatGroup).map((scope) => scope.scopeKey), complete: collection.hasAuthoritativeGlobalSessions });
    }
    return nextFolderAuthorityByOwner;
  }, [bootstrapSnapshot, chatGroup, childStores, collection.hasAuthoritativeGlobalSessions, orderedSectionsForRender]);
  const visibleCountByContainer = React.useMemo(() => new Map([
    ...visibleSessionCountByGroup,
    ...visibleActivityCountByKey,
  ]), [visibleActivityCountByKey, visibleSessionCountByGroup]);
  const sidebarRowModel = React.useMemo(() => buildSessionSidebarRowModel({
    mode: view.hasSessionSearchQuery ? 'search' : 'normal',
    sections: orderedSectionsForRender,
    authoritativeSections: projectSections,
    // Hidden only from the list: folders and search keep the group.
    chatGroup: showChatsSection ? chatGroup : null,
    archivedChatGroup: showChatsSection ? archivedChatGroup : null,
    pinnedItems,
    pinnedWorktrees: pinnedWorktreeEntries,
    workEntries,
    timeEntries,
    draftsByGroupKey: draftPlacement.byGroupKey,
    movedSessionIds,
    movedGroupKeys,
    zoneSessionIds,
    detailedZoneRows,
    foldersMap,
    groupSearchDataByGroup,
    normalizedQuery: view.normalizedSessionSearchQuery,
    collapsedProjects: projectView.collapsedProjects,
    collapsedGroups,
    collapsedFolders: collapsedFolderIds,
    collapsedActivities: projectView.collapsedActivities,
    expandedParents,
    visibleCountByContainer,
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderIndex,
    worktreeArchiveAnchors,
    liveSpaceIds,
    groupStatusByKey,
    folderAuthorityByOwner,
    sessionOwnerById: ownership.bySessionId,
    activeProjectId: view.activeProjectId,
    singleProjectMode,
    singleProjectId: selectedSingleProjectId,
    showOnlyMainWorkspace: view.showOnlyMainWorkspace,
    hideDirectoryControls: view.hideDirectoryControls,
    projectsCaption: !view.hideDirectoryControls,
    sessionBatchSize: singleProjectMode && !view.useGroupedSections ? 20 : undefined,
    runIndex,
  }), [runIndex, archivedChatGroup, chatGroup, showChatsSection, projectView.collapsedActivities, pinnedItems, pinnedWorktreeEntries, workEntries, timeEntries, draftPlacement, movedSessionIds, movedGroupKeys, zoneSessionIds, detailedZoneRows, collapsedFolderIds, collection.pinnedSessionIds, expandedParents, folderAuthorityByOwner, foldersMap, groupSearchDataByGroup, groupStatusByKey, orderedSectionsForRender, ownership.bySessionId, projectSections, collapsedGroups, projectView.collapsedProjects, selectedSingleProjectId, sessionOrderIndex, singleProjectMode, view.activeProjectId, view.hasSessionSearchQuery, view.hideDirectoryControls, view.normalizedSessionSearchQuery, view.showOnlyMainWorkspace, view.useGroupedSections, visibleCountByContainer, worktreeArchiveAnchors, liveSpaceIds]);
  React.useEffect(() => {
    onSearchMatchCountChange(sidebarRowModel.searchMatchCount);
  }, [onSearchMatchCountChange, sidebarRowModel.searchMatchCount]);
  // An empty worktree group or folder is always open; a collapse saved from
  // when it had sessions is dropped, so the next session there shows at once.
  // Collapsing is the user's call again once there is something to hide.
  React.useEffect(() => {
    // Search filters rows, so a group or folder can look empty without being so.
    if (view.hasSessionSearchQuery) return;
    const toggleFolderCollapse = useSessionFoldersStore.getState().toggleFolderCollapse;
    for (const row of sidebarRowModel.rows) {
      if (row.kind === 'group-header' && row.empty && projectView.collapsedGroups.has(row.groupKey)) {
        toggleGroup(row.groupKey);
      } else if (row.kind === 'folder-header' && row.empty && collapsedFolderIds.has(row.folder.id)) {
        toggleFolderCollapse(row.folder.id);
      }
    }
  }, [collapsedFolderIds, projectView.collapsedGroups, sidebarRowModel.rows, toggleGroup, view.hasSessionSearchQuery]);
  const scrollerModel = React.useMemo(() => ({
    rowModel: sidebarRowModel,
    sectionsForRender: orderedSectionsForRender,
    projectSections,
    singleProjectMode,
    emptyState: view.emptyState,
    searchEmptyState: view.searchEmptyState,
    projectRepoStatus: topology.projectRepoStatus,
    state: {
      editingId,
      openSidebarMenuKey,
      setOpenSidebarMenuKey,
      visibleSessionCountByGroup,
      collapsedActivityKeys: projectView.collapsedActivities,
      setCollapsedActivityKeys: setCollapsedActivities,
      visibleActivityCountByKey,
      setVisibleActivityCountByKey,
    },
    groupProps,
  }), [
    groupProps,
    editingId,
    openSidebarMenuKey,
    projectSections,
    orderedSectionsForRender,
    sidebarRowModel,
    topology.projectRepoStatus,
    view.emptyState,
    view.searchEmptyState,
    visibleSessionCountByGroup,
    visibleActivityCountByKey,
    projectView.collapsedActivities,
    setCollapsedActivities,
    singleProjectMode,
  ]);
  const scrollerView = React.useMemo(() => ({
    homeDirectory: view.homeDirectory,
    hasSessionSearchQuery: view.hasSessionSearchQuery,
    hideDirectoryControls: view.hideDirectoryControls,
    mobileVariant: view.mobileVariant,
    alwaysShowActions,
    projectSortOrder: view.projectSortOrder,
  }), [
    view.homeDirectory,
    view.hasSessionSearchQuery,
    view.hideDirectoryControls,
    view.mobileVariant,
    alwaysShowActions,
    view.projectSortOrder,
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
    toggleProject,
    scrollerActions.renderProjectStatusIndicator,
    setSingleProjectId,
  ]);
  return <>
    <SidebarTerminalActivity />
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
    <SessionPrefetchProvider
      sortedSessions={collection.orderedSessions}
      workSessions={workSessions}
      prefetchSession={prefetchSession}
    >
    <SessionRowOrderProvider
      entries={sidebarRowModel.selectionEntries}
      descendantIds={sidebarRowModel.selectionDescendantIds}
      sessionsById={sidebarRowModel.sessionById}
    >
      <SessionBulkActions
        getFolderScopesForProject={getFolderScopesForProject}
        folderOwnerKeyBySessionId={sidebarRowModel.folderOwnerKeyBySessionId}
        isInlineEditing={editingId !== null}
        startFolderRename={startFolderRename}
      />
      <div
        className="contents"
        onPointerEnter={(event) => {
          if (holdsProjectOrder && event.pointerType === 'mouse') setHeldProjectOrder(shownProjectOrderRef.current);
        }}
        onPointerLeave={() => setHeldProjectOrder(null)}
      >
        {view.renderList
          ? view.renderList({ model: scrollerModel, view: scrollerView, actions: scrollerActionSet })
          : <SessionProjectScroller model={scrollerModel} view={scrollerView} actions={scrollerActionSet} />}
      </div>
    </SessionRowOrderProvider>
    </SessionPrefetchProvider>
  </>;
};

/**
 * Built the first time the sidebar is shown and kept while it is closed, so
 * opening the sidebar again does not rebuild and re-measure the whole list in
 * the frame the toggle starts. The closed sidebar skips the list's rendering
 * (see `Sidebar`), and the work it feeds on pauses with `view.isVisible`.
 */
export const SessionProjectCollection: React.FC<SessionProjectCollectionProps> = (props) => {
  const [shown, setShown] = React.useState(props.view.isVisible);
  if (props.view.isVisible && !shown) setShown(true);
  return shown ? <VisibleSessionProjects {...props} /> : null;
};
