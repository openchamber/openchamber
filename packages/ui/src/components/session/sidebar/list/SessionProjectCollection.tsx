import { SidebarTerminalActivity } from './SidebarTerminalActivity';
import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePrefetchSessionMessages } from '@/sync/use-sync';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { getGitHubPrStatusKey, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useOpenPrSummarySync } from '@/hooks/useOpenPrSummarySync';
import { useLinearIssueStateSync } from '@/hooks/useLinearIssueStateSync';
import { getLinkedGitHubPullRequests, getLinkedSidebarIssues } from '@/lib/linkedIssues';
import type { GitHubPullRequestRef } from '@/lib/api/types';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { useArchivedAutoFolders } from '../folders/useArchivedAutoFolders';
import { ProjectSessionSelectionEffect } from '../projects/useProjectSessionSelection';
import type { WorktreeMetadata } from '@/types/worktree';
import { buildActiveSessionNode, useRecentSessionCollection, useSessionProjectCollection } from './sessionCollection';
import { useChildStoreManager } from '@/sync/sync-context';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { useProjectSessionLists } from '../projects/useProjectSessionLists';
import { useSessionSidebarSections } from '../projects/useSessionSidebarSections';
import { SessionPrefetchEffect } from './useSessionPrefetch';
import { normalizePath } from '../utils';
import type { SessionGroup, SessionNode } from '../types';
import { SessionProjectScroller } from '../projects/SessionProjectScroller';
import { useSessionGrouping } from '../projects/useSessionGrouping';
import { SessionBulkActions } from '../folders/SessionBulkActions';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import type { useSessionProjectViewState } from '../projects/useSessionProjectViewState';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { DeleteSessionConfirmState } from '../sessions/useSessionActions';
import { useExpandedParents } from '../sessions/useExpandedParents';
import { getChatsRootForHome, getChatsRootFromDirectory, isChatDirectoryPath } from '@/lib/chatDirectories';
import { isCapacitorApp } from '@/lib/platform';
import { deriveRecentActivitySections, deriveTimelineActivityItems, sessionTreeMatchesSidebarQuery } from '../recent/activitySections';
import { resolveSidebarSessionLocations } from '../recent/sessionLocation';
import { buildSessionSidebarRowModel } from '../sessionSidebarRowModel';
import { useSidebarGroupStatus } from './useSidebarGroupStatus';
import { getSessionFolderOwnerKey, getSessionFolderScopes } from '../sessions/sessionFolderIdentity';
import { SessionRowOrderProvider } from '../sessions/sessionRowOrder';
import { canRequestNativeDirectoryAccess } from '@/lib/desktop';
import { useSidebarSpaces, type SpaceMark } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { buildMultiRunIndex } from '@/lib/multirun/runs';
import { selectBlockingBadgeSessionScopes } from '../sessions/sessionNodeItemUtils';

const PR_NO_PR_RETRY_MS = 5 * 60_000;

// A stable empty array: without a chats group the sections hook must not see a
// new reference on every render.
const EMPTY_STANDALONE_GROUPS: SessionGroup[] = [];

const EMPTY_TIMELINE_ITEMS: ReturnType<typeof deriveTimelineActivityItems> = [];
const EMPTY_WORK_SESSIONS: readonly Session[] = [];

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
    sidebarViewMode: import('@/stores/useSessionDisplayStore').SidebarViewMode;
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
  };
  actions: {
    rowActions: {
      allowReselect: boolean;
      onSessionSelected?: (sessionId: string) => void;
      resetSessionSearch: () => void;
    };
    alwaysShowActions: boolean;
    notifyOnSubtasks: boolean;
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
      'getOrderedGroups' | 'setGroupOrderByProject' | 'toggleGroup' | 'toggleProject'
    >;
  };
};

const VisibleSessionProjects: React.FC<SessionProjectCollectionProps> = ({ topology, view, actions }) => {
  const { alwaysShowActions, notifyOnSubtasks, projectViewActions, rowActions, ...scrollerActions } = actions;
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const collapsedFolderIds = useSessionFoldersStore((state) => state.collapsedFolderIds);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const projectView = view.projectView;
  const { getOrderedGroups, setGroupOrderByProject, toggleGroup, toggleProject } = projectViewActions;
  const collection = useSessionProjectCollection({ knownDirectories: topology.knownDirectories, isVSCode: topology.isVSCode, isVisible: true });
  const authoritativeProjects = useGlobalSyncStore((state) => state.projects);
  const spaceList = useSidebarSpaces();
  // Recent and Timeline rows label a space session with the space's name where a worktree session shows its branch.
  const spaceLabelById = React.useMemo(() => new Map(spaceList.map((space) => [space.id, space.name])), [spaceList]);
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
  const [collapsedActivityKeys, setCollapsedActivityKeys] = React.useState<Set<string>>(new Set());
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
  const showRecentSection = useSessionDisplayStore((state) => state.showRecentSection);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const singleProjectId = useSessionDisplayStore((state) => state.singleProjectId);
  const setSingleProjectId = useSessionDisplayStore((state) => state.setSingleProjectId);
  const supportsSingleProjectMode = !topology.isVSCode && !isCapacitorApp();
  const singleProjectMode = supportsSingleProjectMode && projectDisplayMode === 'single';
  const timelineMode = view.sidebarViewMode === 'timeline' && !topology.isVSCode;
  const recentSessions = useRecentSessionCollection({
    enabled: showRecentSection && !singleProjectMode && !timelineMode,
    isVSCode: topology.isVSCode,
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderRanks: collection.sessionOrderRanks,
    sessions: collection.rootSessions,
  });
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
  const worktreeSortOrder = useSessionDisplayStore((state) => state.worktreeSortOrder);
  const { buildGroupedSessions, filterSessionNodesForSearch, buildGroupSearchText } = useSessionGrouping({
    homeDirectory: view.homeDirectory,
    worktreeMetadata: topology.worktreeMetadata,
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderRanks: collection.sessionOrderRanks,
    gitBranches: topology.gitBranches,
    isVSCode: topology.isVSCode,
    worktreeSortOrder,
    sessionOwners: ownership.bySessionId,
    spacesByProject,
    runKeyBySessionId,
  });
  const { getSessionsForProject, getArchivedSessionsForProject } = useProjectSessionLists({ ownership });
  // Built before the sections hook runs, because that hook owns the search data
  // for every group the sidebar renders — the chats group included. A group the
  // hook never sees renders an empty list while a search is active.
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
        .map((session) => buildActiveSessionNode(collection.childrenMap, session)),
    };
  }, [collection.chatSessions, collection.childrenMap, topology.isVSCode, view.homeDirectory]);
  const standaloneGroups = React.useMemo<SessionGroup[]>(
    () => chatGroup ? [chatGroup] : EMPTY_STANDALONE_GROUPS,
    [chatGroup],
  );
  const { projectSections, groupSearchDataByGroup, sectionsForRender, flatSectionsForRender } = useSessionSidebarSections({
    normalizedProjects: topology.projects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject: topology.availableWorktreesByProject,
    projectRepoStatus: topology.projectRepoStatus,
    projectRootBranches: topology.projectRootBranches,
    gitBranches: topology.gitBranches,
    lastRepoStatus: topology.lastRepoStatus,
    buildGroupedSessions,
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
  const { github, linear } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const ensureEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshTargets = useGitHubPrStatusStore((state) => state.refreshTargets);
  const retriedRef = React.useRef(new Set<string>());
  const sessionOrderIndex = React.useMemo(
    () => new Map(collection.orderedSessions.map((session, index) => [session.id, index])),
    [collection.orderedSessions],
  );
  const orderedSectionsForRender = React.useMemo(
    // The saved drag order belongs to the manual worktree sort only.
    () => (worktreeSortOrder !== 'manual' ? sectionsForSidebarRender : sectionsForSidebarRender.map((section) => {
      const groups = getOrderedGroups(section.project.id, section.groups);
      return groups === section.groups ? section : { ...section, groups };
    })),
    [getOrderedGroups, sectionsForSidebarRender, worktreeSortOrder],
  );
  const recentActivitySections = React.useMemo(() => {
    const nodes = new Map(recentSessions.map((session) => [
      session.id, buildActiveSessionNode(collection.childrenMap, session),
    ]));
    const pending = [...nodes.values()];
    const recentTreeSessions = [];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) break;
      recentTreeSessions.push(node.session);
      pending.push(...node.children);
    }
    const locations = resolveSidebarSessionLocations({
      sessions: recentTreeSessions,
      projects: topology.projects,
      ownerBySessionId: ownership.bySessionId,
      spaceLabelById,
      availableWorktreesByProject: topology.availableWorktreesByProject,
      gitBranches: topology.gitBranches,
      homeDirectory: view.homeDirectory,
      hideBranchMatchingProjectLabel: true,
    });
    return deriveRecentActivitySections({
      sessions: recentSessions,
      getSessionLocation: (sessionId) => locations.get(sessionId) ?? null,
      getSessionNode: (session) => nodes.get(session.id) ?? buildActiveSessionNode(collection.childrenMap, session),
      query: view.hasSessionSearchQuery ? view.normalizedSessionSearchQuery : '',
    });
  }, [collection.childrenMap, ownership.bySessionId, recentSessions, spaceLabelById, topology.availableWorktreesByProject, topology.gitBranches, topology.projects, view.hasSessionSearchQuery, view.homeDirectory, view.normalizedSessionSearchQuery]);

  // Timeline lists the project sessions themselves, in the shared lifecycle
  // order (pinned first), with no project, worktree, or folder structure.
  const timelineItems = React.useMemo(() => {
    if (!timelineMode) return EMPTY_TIMELINE_ITEMS;
    const rootIds = new Set(collection.rootSessions.map((session) => session.id));
    const sessions = collection.orderedSessions.filter((session) => rootIds.has(session.id) && !session.time?.archived);
    const badgeScopesBySessionId = new Map<string, ReturnType<typeof selectBlockingBadgeSessionScopes>>();
    const locations = resolveSidebarSessionLocations({
      sessions,
      projects: topology.projects,
      ownerBySessionId: ownership.bySessionId,
      spaceLabelById,
      availableWorktreesByProject: topology.availableWorktreesByProject,
      gitBranches: topology.gitBranches,
      homeDirectory: view.homeDirectory,
      rootBranchByProjectId: topology.projectRootBranches,
      hideBranchMatchingProjectLabel: false,
    });
    const items = deriveTimelineActivityItems({
      sessions,
      getSessionLocation: (sessionId) => locations.get(sessionId) ?? null,
      // Timeline rows never expand. Keep descendants for the badges before
      // flattening the rendered node; archive/delete still resolve them at action time.
      getSessionNode: (session) => {
        const tree = buildActiveSessionNode(collection.childrenMap, session);
        const location = locations.get(session.id);
        badgeScopesBySessionId.set(session.id, selectBlockingBadgeSessionScopes(tree, false, location?.groupDirectory ?? session.directory ?? null));
        return { ...tree, children: [], worktree: location?.worktree ?? null };
      },
      query: view.hasSessionSearchQuery ? view.normalizedSessionSearchQuery : '',
    });
    return items.map((item) => ({ ...item, blockingBadgeSessionScopes: badgeScopesBySessionId.get(item.node.session.id) }));
  }, [collection.childrenMap, collection.orderedSessions, collection.rootSessions, ownership.bySessionId, spaceLabelById, timelineMode, topology.availableWorktreesByProject, topology.gitBranches, topology.projectRootBranches, topology.projects, view.hasSessionSearchQuery, view.homeDirectory, view.normalizedSessionSearchQuery]);

  // Sessions in work: top-level, unarchived project sessions (Chats are plain
  // conversations and never in work), in the shared lifecycle order.
  // They leave every other projection, so the row model gets the id set too.
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const workSessions = React.useMemo(() => {
    if (!sessionWorkEnabled) return EMPTY_WORK_SESSIONS;
    const sessions = collection.orderedSessions.filter((session) => !session.parentID && !session.time?.archived && !isChatDirectoryPath(session.directory) && isSessionInWork(session));
    return sessions.length > 0 ? sessions : EMPTY_WORK_SESSIONS;
  }, [collection.orderedSessions, sessionWorkEnabled]);
  const workSessionIds = React.useMemo(() => new Set(workSessions.map((session) => session.id)), [workSessions]);
  const workItems = React.useMemo(() => {
    if (workSessions.length === 0) return EMPTY_TIMELINE_ITEMS;
    const locations = resolveSidebarSessionLocations({
      sessions: [...workSessions],
      projects: topology.projects,
      ownerBySessionId: ownership.bySessionId,
      spaceLabelById,
      availableWorktreesByProject: topology.availableWorktreesByProject,
      gitBranches: topology.gitBranches,
      homeDirectory: view.homeDirectory,
      rootBranchByProjectId: topology.projectRootBranches,
      hideBranchMatchingProjectLabel: !timelineMode,
    });
    // Timeline rows never expand; the Projects view keeps subsessions
    // reachable, the way Recent does, and searches the whole tree: these
    // sessions are nowhere else in the sidebar.
    const badgeScopesBySessionId = new Map<string, ReturnType<typeof selectBlockingBadgeSessionScopes>>();
    const nodes = new Map(workSessions.map((session) => {
      const tree = buildActiveSessionNode(collection.childrenMap, session);
      if (timelineMode) {
        badgeScopesBySessionId.set(session.id, selectBlockingBadgeSessionScopes(tree, false, locations.get(session.id)?.groupDirectory ?? session.directory ?? null));
      }
      const node: SessionNode = {
        ...tree,
        children: timelineMode ? [] : tree.children,
        worktree: locations.get(session.id)?.worktree ?? null,
      };
      return [session.id, node];
    }));
    const query = view.hasSessionSearchQuery ? view.normalizedSessionSearchQuery : '';
    const listed = query
      ? workSessions.filter((session) => {
        const node = nodes.get(session.id);
        return node ? sessionTreeMatchesSidebarQuery(node, query) : false;
      })
      : [...workSessions];
    const items = deriveTimelineActivityItems({
      sessions: listed,
      getSessionLocation: (sessionId) => locations.get(sessionId) ?? null,
      getSessionNode: (session) => nodes.get(session.id) ?? buildActiveSessionNode(collection.childrenMap, session),
      query: '',
    });
    return timelineMode
      ? items.map((item) => ({ ...item, blockingBadgeSessionScopes: badgeScopesBySessionId.get(item.node.session.id) }))
      : items;
  }, [collection.childrenMap, ownership.bySessionId, spaceLabelById, timelineMode, topology.availableWorktreesByProject, topology.gitBranches, topology.projectRootBranches, topology.projects, view.hasSessionSearchQuery, view.homeDirectory, view.normalizedSessionSearchQuery, workSessions]);
  // Worktree branches whose PR badge is on screen in the current mode:
  // Timeline rows there; expanded project groups plus Recent rows in the
  // Projects view; In work rows in both. Collapse state from the Projects
  // view must not decide what a Timeline badge shows.
  const shownPrs = React.useMemo(() => {
    const targets = new Map<string, { directory: string; branch: string }>();
    // PRs and GitHub issues linked to the sessions on screen, whatever their
    // branch.
    const linkedRefs = new Map<string, GitHubPullRequestRef>();
    const linkedIssueRefs = new Map<string, GitHubPullRequestRef>();
    // Linear issues linked to the sessions on screen; their state comes from
    // Linear, on its own cadence below.
    const linearIdentifiers = new Set<string>();
    const addTarget = (directory: string | null, branch: string | null | undefined) => {
      const trimmed = branch?.trim();
      if (directory && trimmed) targets.set(getGitHubPrStatusKey(directory, trimmed), { directory, branch: trimmed });
    };
    // Same pair a row derives its badge key from (resolveSessionPrLookupKey).
    const addNode = (node: SessionNode) => {
      addTarget(normalizePath(node.worktree?.path ?? null), node.worktree?.branch);
      if (!topology.isVSCode) {
        for (const link of getLinkedGitHubPullRequests(node.session)) {
          linkedRefs.set(`${link.owner.toLowerCase()}/${link.repo.toLowerCase()}#${link.number}`, { owner: link.owner, repo: link.repo, number: link.number });
        }
        for (const issue of getLinkedSidebarIssues(node.session)) {
          if (issue.source === 'github') {
            linkedIssueRefs.set(`${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}`, { owner: issue.owner, repo: issue.repo, number: issue.number });
          } else if (issue.source === 'linear') {
            linearIdentifiers.add(issue.identifier.toUpperCase());
          }
        }
      }
      node.children.forEach(addNode);
    };
    workItems.forEach((item) => addNode(item.node));
    if (timelineMode) {
      timelineItems.forEach((item) => addNode(item.node));
      return { targets, linkedRefs: [...linkedRefs.values()], linkedIssueRefs: [...linkedIssueRefs.values()], linearIdentifiers: [...linearIdentifiers] };
    }
    recentActivitySections.forEach((section) => section.items.forEach((item) => addNode(item.node)));
    projectSections.forEach((section) => {
      if (projectView.collapsedProjects.has(section.project.id)) return;
      section.groups.forEach((group) => {
        if (group.isArchivedBucket) return;
        // Root sessions show linked PRs too; only worktree groups have a
        // branch PR of their own.
        group.sessions.forEach(addNode);
        if (group.isMain) return;
        const directory = normalizePath(group.directory ?? null);
        addTarget(directory, group.branch?.trim() || topology.gitBranches.get(directory || ''));
      });
    });
    return { targets, linkedRefs: [...linkedRefs.values()], linkedIssueRefs: [...linkedIssueRefs.values()], linearIdentifiers: [...linearIdentifiers] };
  }, [projectSections, projectView.collapsedProjects, recentActivitySections, timelineItems, timelineMode, topology.gitBranches, topology.isVSCode, workItems]);
  const shownPrTargets = shownPrs.targets;
  const shownPrKeys = React.useMemo(() => [...shownPrTargets.keys()], [shownPrTargets]);
  const githubConnected = Boolean(githubAuthChecked && githubAuthStatus?.connected);
  // Discovery: find the PR of a branch that has none yet, or whose PR is
  // closed/merged (a newer one may have opened). Open PRs stay live through
  // the batched summaries below instead.
  React.useEffect(() => {
    if (!github || !githubConnected) return;
    const targets = new Map<string, { directory: string; branch: string }>();
    const now = Date.now();
    shownPrTargets.forEach(({ directory, branch }, key) => {
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
    targets.forEach((target, key) => {
      ensureEntry(key);
      setParams(key, { ...target, remoteName: null, canShow: true, github, githubAuthChecked, githubConnected });
    });
    if (targets.size) void refreshTargets([...targets.values()], { silent: true, markInitialResolved: true });
  }, [ensureEntry, github, githubAuthChecked, githubConnected, refreshTargets, setParams, shownPrTargets]);
  useOpenPrSummarySync(shownPrKeys, shownPrs.linkedRefs, shownPrs.linkedIssueRefs, github, githubConnected);
  useLinearIssueStateSync(shownPrs.linearIdentifiers, linear);

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
    notifyOnSubtasks,
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
    onEditProject: timelineMode ? scrollerActions.openProjectEditDialog : undefined,
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
    editingRowKey,
    expandedParents,
    folderRename,
    setFolderRenameDraft,
    clearFolderRename,
    startFolderRename,
    deleteSessionConfirm,
    actions.startSessionWorktreeMenuLoad,
    scrollerActions.openProjectEditDialog,
    timelineMode,
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
    viewMode: timelineMode ? 'timeline' : 'projects',
    sections: orderedSectionsForRender,
    authoritativeSections: projectSections,
    chatGroup,
    recentSections: recentActivitySections,
    timelineItems,
    workItems,
    workSessionIds,
    showRecentSection: showRecentSection && !singleProjectMode && !timelineMode,
    foldersMap,
    groupSearchDataByGroup,
    normalizedQuery: view.normalizedSessionSearchQuery,
    collapsedProjects: projectView.collapsedProjects,
    collapsedGroups: projectView.collapsedGroups,
    collapsedFolders: collapsedFolderIds,
    collapsedActivities: collapsedActivityKeys,
    expandedParents,
    visibleCountByContainer,
    pinnedSessionIds: collection.pinnedSessionIds,
    sessionOrderIndex,
    groupStatusByKey,
    folderAuthorityByOwner,
    activeProjectId: view.activeProjectId,
    singleProjectMode: singleProjectMode && !timelineMode,
    singleProjectId: selectedSingleProjectId,
    showOnlyMainWorkspace: view.showOnlyMainWorkspace,
    hideDirectoryControls: view.hideDirectoryControls,
    sessionBatchSize: singleProjectMode && !view.useGroupedSections ? 20 : undefined,
    runIndex,
  }), [runIndex, chatGroup, collapsedActivityKeys, timelineItems, timelineMode, workItems, workSessionIds, collapsedFolderIds, collection.pinnedSessionIds, expandedParents, folderAuthorityByOwner, foldersMap, groupSearchDataByGroup, groupStatusByKey, orderedSectionsForRender, projectSections, projectView.collapsedGroups, projectView.collapsedProjects, recentActivitySections, selectedSingleProjectId, sessionOrderIndex, showRecentSection, singleProjectMode, view.activeProjectId, view.hasSessionSearchQuery, view.hideDirectoryControls, view.normalizedSessionSearchQuery, view.showOnlyMainWorkspace, view.useGroupedSections, visibleCountByContainer]);
  React.useEffect(() => {
    onSearchMatchCountChange(sidebarRowModel.searchMatchCount);
  }, [onSearchMatchCountChange, sidebarRowModel.searchMatchCount]);
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
      collapsedActivityKeys,
      setCollapsedActivityKeys,
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
    collapsedActivityKeys,
    singleProjectMode,
  ]);
  const scrollerView = React.useMemo(() => ({
    homeDirectory: view.homeDirectory,
    hasSessionSearchQuery: view.hasSessionSearchQuery,
    hideDirectoryControls: view.hideDirectoryControls,
    stickyZoneHeaders: view.stickyZoneHeaders,
    mobileVariant: view.mobileVariant,
    alwaysShowActions,
    projectSortOrder: view.projectSortOrder,
    worktreeSortOrder,
    timelineView: timelineMode,
  }), [
    timelineMode,
    worktreeSortOrder,
    view.homeDirectory,
    view.hasSessionSearchQuery,
    view.hideDirectoryControls,
    view.mobileVariant,
    alwaysShowActions,
    view.projectSortOrder,
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
    <SessionPrefetchEffect
      sortedSessions={collection.orderedSessions}
      recentSessions={recentSessions}
      prefetchSession={prefetchSession}
    />
    <SessionRowOrderProvider
      entries={sidebarRowModel.selectionEntries}
      descendantIds={sidebarRowModel.selectionDescendantIds}
      sessionsById={sidebarRowModel.sessionById}
    >
      <SessionBulkActions
        getFolderScopesForProject={getFolderScopesForProject}
        isInlineEditing={editingId !== null}
        startFolderRename={startFolderRename}
      />
      <SessionProjectScroller model={scrollerModel} view={scrollerView} actions={scrollerActionSet} />
    </SessionRowOrderProvider>
  </>;
};

export const SessionProjectCollection: React.FC<SessionProjectCollectionProps> = (props) => props.view.isVisible ? <VisibleSessionProjects {...props} /> : null;
