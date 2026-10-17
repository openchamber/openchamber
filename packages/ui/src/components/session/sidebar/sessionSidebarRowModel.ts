import type { Session } from '@/lib/opencode/model';
import type { SessionFolder, SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import { compareSessionsByLifecycleOrder, EMPTY_SESSION_ORDER_RANKS } from '@/sync/session-ordering';
import { isSessionPinned } from '@/lib/sessionPins';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildGroupRenderDescriptors } from './projects/sessionProjectRender';
import { normalizeFolderRoots, selectFolderIdsForProjection, selectFolderRootNodes, type BlockingBadgeSessionScope } from './sessions/sessionNodeItemUtils';
import { getSessionFolderIdentityKey, getSessionFolderOwnerKey, getSessionFolderScopes, isArchivedFolderScope } from './sessions/sessionFolderIdentity';
import type { SessionRowOrderEntry } from './sessions/sessionRowOrder';
import { countSessionTreeQueryMatches } from './recent/activitySections';
import { EMPTY_MULTI_RUN_INDEX, type MultiRunIndex, type MultiRunSummary } from '@/lib/multirun/runs';

export type SessionSidebarActivityItem = {
  node: SessionNode;
  blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null } | null;
  getSecondaryMeta?: (sessionId: string) => SessionSidebarActivityItem['secondaryMeta'];
  /** Search matches in the session's whole tree, for zone rows whose node drops its children. */
  searchMatchCount?: number;
};

export type SessionSidebarActivityKey = 'pinned' | 'work' | 'chats';

/** Activity sections; the display menu's Collapse all / Expand all drive them with the projects. */
export const SIDEBAR_ACTIVITY_KEYS: readonly SessionSidebarActivityKey[] = ['chats', 'pinned', 'work'];

// 'project' is a one-line file tree row of the grouped view. Timeline rows
// have no left gutter and carry their status on the right: 'timeline' is a
// two-line row under its project header; 'timeline-mixed' is the same row in
// Pinned and In work, where sessions of every project mix, so its second line
// opens with the project's icon; 'mixed-compact' is that row on one line, the
// Tree view's default for Pinned and In work; 'timeline-chat' is a one-line
// Chats row in List, 'tree-chat' the same row in Tree.
export type SessionSidebarRenderContext = 'project' | 'timeline' | 'timeline-mixed' | 'mixed-compact' | 'timeline-chat' | 'tree-chat';

/**
 * Rows that keep the tree's geometry and its slot left of the title, which
 * shows the live state: everything in Tree but the detailed zone rows. List
 * rows are flat and show the state on the right.
 */
export const hasTreeSlotContext = (context: SessionSidebarRenderContext): boolean => (
  context === 'project' || context === 'mixed-compact' || context === 'tree-chat'
);

/** Rows that render through `SessionTimelineRowBody` with two lines. */
export const isTwoLineTimelineContext = (context: SessionSidebarRenderContext): boolean => (
  context === 'timeline' || context === 'timeline-mixed'
);

/** Flat zone and timeline rows never expand: a run row opens its overview instead. */
const isNeverExpandedContext = (context: SessionSidebarRenderContext): boolean => (
  isTwoLineTimelineContext(context) || context === 'mixed-compact'
);

export type SessionSidebarViewMode = 'projects' | 'timeline';

export type SessionSidebarGroupStatus = {
  state: 'ready' | 'loading' | 'load-failed' | 'initialization-failed' | 'permission-denied';
  directory: string | null;
  canGrantAccess: boolean;
};

export type SessionSidebarOwnerAuthority = {
  scopeKeys: readonly string[];
  complete: boolean;
};

type RowBase = { key: string; estimateSize: number };

export type SessionSidebarRow =
  | (RowBase & { kind: 'activity-header'; activityKey: SessionSidebarActivityKey; collapsed: boolean; forceExpanded: boolean })
  | (RowBase & { kind: 'project-header'; section: ProjectSection; collapsed: boolean; forceExpanded: boolean })
  // `empty`: nothing to list under the header, so it offers no chevron.
  | (RowBase & { kind: 'group-header'; group: SessionGroup; groupKey: string; projectId: string | null; collapsed: boolean; forceExpanded: boolean; empty: boolean; allSessions: readonly Session[] })
  | (RowBase & { kind: 'folder-header'; depth: number; group: SessionGroup; folder: SessionFolder; displayName: string; scopeKey: string; scopeDirectory: string | null; ownerKey: string | null; nodes: readonly SessionNode[]; activityNodes: readonly SessionNode[]; projectId: string | null; archived: boolean; collapsed: boolean; forceExpanded: boolean; empty: boolean; deleteSessions: readonly Session[]; subFolderCount: number; dropEnabled: boolean })
  | (RowBase & { kind: 'session'; node: SessionNode; blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[]; depth: number; projectId: string | null; groupDirectory: string | null; ownerKey: string | null; selectionScopeKey: string | null; archived: boolean; renderContext: SessionSidebarRenderContext; secondaryMeta: SessionSidebarActivityItem['secondaryMeta'] })
  // A multi-run: one derived parent row over its member sessions. It is not a
  // session, so it never enters selection, and its lanes render as session
  // rows one level deeper when it is expanded.
  | (RowBase & { kind: 'run'; run: MultiRunSummary; depth: number; laneNodes: readonly SessionNode[]; blockingSessionIds: readonly string[]; projectId: string | null; projectLabel: string | null; groupDirectory: string | null; renderContext: SessionSidebarRenderContext; expansionKey: string; expanded: boolean; forceExpanded: boolean })
  // The rows below line up with the text of the rows they close: `flat` with
  // gutterless timeline-style rows, otherwise with the tree level `depth`.
  | (RowBase & { kind: 'empty'; emptyKind: 'sidebar' | 'search' | 'archived'; depth?: number })
  | (RowBase & { kind: 'status'; status: SessionSidebarGroupStatus; group: SessionGroup; groupKey: string; depth?: number; flat?: boolean })
  | (RowBase & { kind: 'show-control'; control: 'more' | 'fewer'; containerKey: string; currentCount: number; increment: number; depth?: number; flat?: boolean });

export type SessionSidebarStickyHeader = {
  rowIndex: number;
  kind: 'activity' | 'project';
  id: string;
};

export type SessionSidebarFolderTarget = {
  rowKey: string;
  scopeKey: string;
  folderId: string;
  ownerKey: string;
  enabled: boolean;
};

export type SessionSidebarRowModel = {
  rows: readonly SessionSidebarRow[];
  selectionEntries: readonly SessionRowOrderEntry[];
  selectionDescendantIds: readonly string[];
  rowIndexByKey: ReadonlyMap<string, number>;
  stickyHeaders: readonly SessionSidebarStickyHeader[];
  folderDropTargets: readonly SessionSidebarFolderTarget[];
  folderAuthorityByOwner: ReadonlyMap<string, SessionSidebarOwnerAuthority>;
  sessionById: ReadonlyMap<string, Session>;
  searchMatchCount: number;
};

export type SessionSidebarRowModelArgs = {
  mode: 'normal' | 'search';
  /**
   * Projects renders the project/worktree tree. Timeline renders one header
   * per project over a flat, lifecycle-ordered list of its non-archived root
   * sessions, with no worktree groups or folders.
   */
  viewMode?: SessionSidebarViewMode;
  sections: readonly ProjectSection[];
  authoritativeSections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  /** Every non-archived root project session with its project, in lifecycle order. */
  timelineItems?: readonly SessionSidebarActivityItem[];
  /**
   * Pinned sessions and sessions in work, already ordered and
   * search-filtered. Each zone renders as its own block at the top, and its
   * sessions stay under their project too. Search lists each of them once,
   * in its zone.
   */
  pinnedItems?: readonly SessionSidebarActivityItem[];
  workItems?: readonly SessionSidebarActivityItem[];
  /** Every session listed in the Pinned or In work zone. */
  zoneSessionIds?: ReadonlySet<string>;
  /** Pinned and In work rows in the Tree view: two lines when set, one otherwise. */
  detailedZoneRows?: boolean;
  foldersMap: SessionFoldersMap;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  normalizedQuery: string;
  collapsedProjects: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  collapsedFolders: ReadonlySet<string>;
  collapsedActivities: ReadonlySet<string>;
  expandedParents: ReadonlySet<string>;
  visibleCountByContainer: ReadonlyMap<string, number>;
  pinnedSessionIds: ReadonlySet<string>;
  sessionOrderIndex: ReadonlyMap<string, number>;
  groupStatusByKey: ReadonlyMap<string, SessionSidebarGroupStatus>;
  folderAuthorityByOwner: ReadonlyMap<string, SessionSidebarOwnerAuthority>;
  activeProjectId: string | null;
  singleProjectMode: boolean;
  singleProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hideDirectoryControls: boolean;
  sessionBatchSize?: number;
  /** Active multi-runs; their member sessions collapse into one run row per container. */
  runIndex?: MultiRunIndex;
};

type RunEntry = { run: MultiRunSummary; lanes: SessionNode[] };
type SidebarEntry = SessionNode | RunEntry;

const isRunEntry = (entry: SidebarEntry): entry is RunEntry => 'run' in entry;

export const runExpansionKey = (renderContext: SessionSidebarRenderContext, runKey: string): string => (
  `${renderContext}:active:run:${runKey}`
);

/**
 * Replaces the member sessions of each run with one entry at the position of
 * its first member (entries arrive in display order). Archived lists never
 * collapse: archived sessions are not run members.
 */
const collapseRunEntries = (nodes: readonly SessionNode[], runIndex: MultiRunIndex, archived: boolean): SidebarEntry[] => {
  if (archived || runIndex.runKeyBySessionId.size === 0) return [...nodes];
  const entries: SidebarEntry[] = [];
  const byRun = new Map<string, RunEntry>();
  for (const node of nodes) {
    const runKey = runIndex.runKeyBySessionId.get(node.session.id);
    const run = runKey ? runIndex.runs.get(runKey) : undefined;
    if (!run) {
      entries.push(node);
      continue;
    }
    const existing = byRun.get(run.key);
    if (existing) {
      existing.lanes.push(node);
      continue;
    }
    const entry: RunEntry = { run, lanes: [node] };
    byRun.set(run.key, entry);
    entries.push(entry);
  }
  for (const entry of byRun.values()) {
    const order = new Map(entry.run.memberIds.map((id, index) => [id, index]));
    entry.lanes.sort((left, right) => (order.get(left.session.id) ?? 0) - (order.get(right.session.id) ?? 0));
  }
  return entries;
};

/**
 * How many sessions of search-filtered trees a group reports as matches: for
 * a `ses_` id query the exact id only, otherwise every session the search
 * kept. Group search data and the row model both count with this, so taking
 * trees out of a group takes exactly their share out of its count.
 */
export const countSessionSearchMatches = (nodes: readonly SessionNode[], normalizedQuery: string): number => {
  const idQuery = normalizedQuery.trim().toLowerCase();
  const isIdQuery = idQuery.startsWith('ses_');
  const count = (list: readonly SessionNode[]): number => list.reduce((total, node) => (
    total + (!isIdQuery || node.session.id.toLowerCase() === idQuery ? 1 : 0) + count(node.children)
  ), 0);
  return count(nodes);
};

const EMPTY_FOLDERS: readonly SessionFolder[] = [];
const EMPTY_ZONE_SESSION_IDS: ReadonlySet<string> = new Set();
const SESSION_ESTIMATE = 32;
const TIMELINE_SESSION_ESTIMATE = 52;
// Chats open on a short page in both views, with pinned chats on top of it.
const CHATS_INITIAL_LIMIT = 3;
const CHATS_INCREMENT = 7;
// Project and worktree lists reveal 7 sessions per page in both views.
const SESSIONS_INITIAL_LIMIT = 7;
const SESSIONS_INCREMENT = 7;

/** Show more / Show fewer state of a project's session list in the timeline. */
export const timelineProjectContainerKey = (projectId: string): string => `timeline-project:${projectId}`;
const HEADER_ESTIMATE = 32;
const STATUS_ESTIMATE = 28;

const compareNodes = (
  left: SessionNode,
  right: SessionNode,
  pinnedSessionIds: Set<string>,
  sessionOrderIndex: ReadonlyMap<string, number>,
): number => {
  const leftIndex = sessionOrderIndex.get(left.session.id);
  const rightIndex = sessionOrderIndex.get(right.session.id);
  if (leftIndex !== undefined || rightIndex !== undefined) {
    if (leftIndex === undefined) return 1;
    if (rightIndex === undefined) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  return compareSessionsByLifecycleOrder(left.session, right.session, pinnedSessionIds, EMPTY_SESSION_ORDER_RANKS);
};

type FolderProjection = {
  folder: SessionFolder;
  scopeKey: string;
  scopeDirectory: string | null;
  ownerKey: string | null;
  nodes: readonly SessionNode[];
};

type IndexedSessionNodes = {
  byId: ReadonlyMap<string, SessionNode>;
  sessionsById: ReadonlyMap<string, Session>;
  preorderIds: readonly string[];
  subtreeRangeByNode: WeakMap<SessionNode, readonly [start: number, end: number]>;
};

const indexNodes = (roots: readonly SessionNode[]): IndexedSessionNodes => {
  const byId = new Map<string, SessionNode>();
  const sessionsById = new Map<string, Session>();
  const preorderIds: string[] = [];
  const subtreeRangeByNode = new WeakMap<SessionNode, readonly [start: number, end: number]>();
  const stack: Array<{ node: SessionNode; visited: boolean }> = roots.map((node) => ({ node, visited: false })).reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    if (!entry.visited) {
      byId.set(entry.node.session.id, entry.node);
      sessionsById.set(entry.node.session.id, entry.node.session);
      const start = preorderIds.length;
      preorderIds.push(entry.node.session.id);
      subtreeRangeByNode.set(entry.node, [start, start + 1]);
      stack.push({ node: entry.node, visited: true });
      for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
        const child = entry.node.children[index];
        if (child) stack.push({ node: child, visited: false });
      }
      continue;
    }
    const current = subtreeRangeByNode.get(entry.node);
    if (current) subtreeRangeByNode.set(entry.node, Object.freeze([current[0], preorderIds.length]));
  }
  return { byId, sessionsById, preorderIds: Object.freeze(preorderIds), subtreeRangeByNode };
};

const expandedKey = (renderContext: SessionSidebarRenderContext, archived: boolean, id: string): string => (
  `${renderContext}:${archived ? 'archived' : 'active'}:${id}`
);

export const resolveSessionSidebarStickyHeader = (
  stickyHeaders: readonly SessionSidebarStickyHeader[],
  firstVisibleIndex: number,
): SessionSidebarStickyHeader | null => {
  let result: SessionSidebarStickyHeader | null = null;
  for (const descriptor of stickyHeaders) {
    if (descriptor.rowIndex > firstVisibleIndex) break;
    result = descriptor;
  }
  return result;
};

export const buildSessionSidebarRowModel = (args: SessionSidebarRowModelArgs): SessionSidebarRowModel => {
  const rows: SessionSidebarRow[] = [];
  const selectionEntries: SessionRowOrderEntry[] = [];
  const selectionDescendantIds: string[] = [];
  const stickyHeaders: SessionSidebarStickyHeader[] = [];
  const folderDropTargets: SessionSidebarFolderTarget[] = [];
  const sessionById = new Map<string, Session>();
  const keyOccurrences = new Map<string, number>();
  const search = args.mode === 'search';
  const pinned = args.pinnedSessionIds instanceof Set ? args.pinnedSessionIds : new Set(args.pinnedSessionIds);
  const inZone = args.zoneSessionIds ?? EMPTY_ZONE_SESSION_IDS;
  // A pinned session or one in work also stays in its project; only search
  // lists it once, in its zone, so its count and rows agree.
  const isMovedToZone = (sessionId: string): boolean => search && inZone.has(sessionId);
  let searchMatchCount = 0;

  const authoritativeRoots = [
    ...args.authoritativeSections.flatMap((section) => section.groups.flatMap((group) => group.sessions)),
    ...(args.chatGroup?.sessions ?? []),
  ];
  const authorityStack = [...authoritativeRoots];
  while (authorityStack.length > 0) {
    const node = authorityStack.pop();
    if (!node) continue;
    sessionById.set(node.session.id, node.session);
    authorityStack.push(...node.children);
  }

  const keyFor = (base: string): string => {
    const occurrence = keyOccurrences.get(base) ?? 0;
    keyOccurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:${occurrence}`;
  };
  const push = (row: SessionSidebarRow): void => {
    rows.push(Object.freeze(row));
  };
  type AppendOptions = {
    nodes: readonly SessionNode[];
    blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
    containerKey: string;
    projectId: string | null;
    groupDirectory: string | null;
    ownerKey: string | null;
    selectionScopeKey: string | null;
    archived: boolean;
    renderContext: SessionSidebarRenderContext;
    secondaryMeta?: SessionSidebarActivityItem['secondaryMeta'];
    getSecondaryMeta?: SessionSidebarActivityItem['getSecondaryMeta'];
    // Per-row badge scopes for containers whose top rows come from different
    // activity items, such as the lanes of a multi-run.
    getBlockingBadgeSessionScopes?: (sessionId: string) => readonly BlockingBadgeSessionScope[] | undefined;
    indexedNodes?: IndexedSessionNodes;
    selectionPoolOffset?: number;
    // Nesting level of the container's top rows: 1 inside a folder, so its
    // sessions indent under the folder header like subagent children do.
    baseDepth?: number;
  };
  const runIndex = args.runIndex ?? EMPTY_MULTI_RUN_INDEX;
  const appendRun = (entry: RunEntry, options: AppendOptions): void => {
    const expansionKey = runExpansionKey(options.renderContext, entry.run.key);
    // Timeline rows never expand; the overview lists the lanes.
    const expanded = !isNeverExpandedContext(options.renderContext) && (search || args.expandedParents.has(expansionKey));
    const firstLaneId = entry.lanes[0]?.session.id;
    const meta = firstLaneId && options.getSecondaryMeta ? options.getSecondaryMeta(firstLaneId) : options.secondaryMeta;
    // Activity lanes come without their subagent rows, so the sessions whose
    // requests block a lane (the lane and its hidden subagents) ride along for
    // the run row's badge.
    const blockingSessionIds = Object.freeze([...new Set(entry.lanes.flatMap((lane) => (
      options.getBlockingBadgeSessionScopes?.(lane.session.id) ?? []
    ).flatMap((scope) => scope.sessionIDs)))]);
    push({
      kind: 'run',
      key: keyFor(`${options.containerKey}:run:${entry.run.key}`),
      estimateSize: isTwoLineTimelineContext(options.renderContext) ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE,
      run: entry.run,
      depth: options.baseDepth ?? 0,
      laneNodes: Object.freeze([...entry.lanes]),
      blockingSessionIds,
      projectId: options.projectId,
      projectLabel: meta?.projectLabel ?? null,
      groupDirectory: options.groupDirectory,
      renderContext: options.renderContext,
      expansionKey,
      expanded,
      forceExpanded: search,
    });
    if (!expanded) return;
    appendTrees(entry.lanes, (options.baseDepth ?? 0) + 1, options);
  };
  const appendSessions = (options: AppendOptions): void => {
    for (const entry of collapseRunEntries(options.nodes, runIndex, options.archived)) {
      if (isRunEntry(entry)) appendRun(entry, options);
      else appendTrees([entry], options.baseDepth ?? 0, options);
    }
  };
  const appendTrees = (nodes: readonly SessionNode[], baseDepth: number, options: AppendOptions): void => {
    const stack = [...nodes].reverse().map((node) => ({ node, depth: baseDepth, directory: options.groupDirectory }));
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const rowKey = keyFor(`${options.containerKey}:session:${current.node.session.id}`);
      const directory = current.node.session.directory ?? current.directory;
      sessionById.set(current.node.session.id, current.node.session);
      push({
        kind: 'session',
        key: rowKey,
        estimateSize: isTwoLineTimelineContext(options.renderContext) ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE,
        node: current.node,
        blockingBadgeSessionScopes: current.depth === baseDepth
          ? options.getBlockingBadgeSessionScopes?.(current.node.session.id) ?? options.blockingBadgeSessionScopes
          : undefined,
        depth: current.depth,
        projectId: options.projectId,
        groupDirectory: current.directory,
        ownerKey: options.ownerKey,
        selectionScopeKey: options.selectionScopeKey,
        archived: options.archived,
        renderContext: options.renderContext,
        secondaryMeta: options.getSecondaryMeta
          ? options.getSecondaryMeta(current.node.session.id)
          : options.secondaryMeta ?? null,
      });
      const subtreeRange = options.indexedNodes?.subtreeRangeByNode.get(current.node);
      const descendantRange = subtreeRange && subtreeRange[1] > subtreeRange[0] + 1
        ? Object.freeze([
          (options.selectionPoolOffset ?? 0) + subtreeRange[0] + 1,
          (options.selectionPoolOffset ?? 0) + subtreeRange[1],
        ] as const)
        : undefined;
      selectionEntries.push(Object.freeze({
        id: current.node.session.id,
        rowKey,
        scopeKey: options.selectionScopeKey,
        archived: options.archived,
        descendantRange,
      }));
      if (!search && !args.expandedParents.has(expandedKey(options.renderContext, options.archived, current.node.session.id))) continue;
      for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
        const child = current.node.children[index];
        if (child) stack.push({ node: child, depth: current.depth + 1, directory });
      }
    }
  };

  // A group's search matches once the trees listed in a zone are taken out:
  // those render in Pinned or In work, which counts them. Zero means nothing to show.
  const groupSearchMatches = (group: SessionGroup): number => {
    const searchData = args.groupSearchDataByGroup.get(group);
    if (searchData?.hasMatch !== true) return 0;
    const movedToZone = inZone.size > 0 ? searchData.filteredNodes.filter((node) => isMovedToZone(node.session.id)) : [];
    const sessionMatches = Math.max(0, searchData.matchedSessionCount - countSessionSearchMatches(movedToZone, args.normalizedQuery));
    return sessionMatches + searchData.folderNameMatchCount + (searchData.groupMatches ? 1 : 0);
  };

  const appendGroup = (
    group: SessionGroup,
    groupKey: string,
    projectId: string | null,
    hideHeader: boolean,
    limits?: { initial?: number; increment?: number; pinnedAlwaysVisible?: boolean; renderContext: SessionSidebarRenderContext },
  ): void => {
    const searchData = args.groupSearchDataByGroup.get(group);
    if (search) {
      const matches = groupSearchMatches(group);
      if (matches === 0) return;
      searchMatchCount += matches;
    }
    const sourceNodes = (search ? searchData?.filteredNodes ?? [] : group.sessions)
      .filter((node) => !isMovedToZone(node.session.id))
      .sort((left, right) => compareNodes(left, right, pinned, args.sessionOrderIndex));
    const indexed = indexNodes(sourceNodes);
    const selectionPoolOffset = selectionDescendantIds.length;
    selectionDescendantIds.push(...indexed.preorderIds);
    for (const [id, session] of indexed.sessionsById) sessionById.set(id, session);
    const ownerKey = getSessionFolderOwnerKey(projectId, group.directory);
    const storedCollapsed = !search && args.collapsedGroups.has(groupKey);
    // A worktree, space or archive header is a tree node of its own: its
    // folders and sessions sit one level under it. The project root group has
    // no header, so its contents sit right under the project.
    const contentDepth = hideHeader ? 0 : 1;
    // Chats render gutterless rows in List; in Tree they keep the slot.
    const flat = limits !== undefined && !hasTreeSlotContext(limits.renderContext);
    const status = args.groupStatusByKey.get(groupKey);
    const groupLoaded = !status || status.state === 'ready';
    // Nothing to list: no sessions, no folders, and no loading or failure
    // line to show.
    const empty = sourceNodes.length === 0
      && groupLoaded
      && getSessionFolderScopes(group).every(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).length === 0);
    if (!hideHeader) {
      const allSessions = indexed.preorderIds.flatMap((id) => indexed.sessionsById.get(id) ?? []);
      push({ kind: 'group-header', key: `${groupKey}:header`, estimateSize: HEADER_ESTIMATE, group, groupKey, projectId, collapsed: storedCollapsed && !empty, forceExpanded: search, empty, allSessions: Object.freeze(allSessions) });
    }
    // An empty group is always open, so its first session shows at once.
    if (storedCollapsed && !empty) return;

    const folderEntries = getSessionFolderScopes(group).flatMap(({ scopeKey, directory }) => (
      (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).map((folder): FolderProjection => ({
        folder,
        scopeKey,
        scopeDirectory: directory,
        ownerKey,
        nodes: selectFolderRootNodes(folder.sessionIds, indexed.byId).sort((left, right) => compareNodes(left, right, pinned, args.sessionOrderIndex)),
      }))
    ));
    const visibleFolderKeys = selectFolderIdsForProjection(folderEntries.map((entry) => ({
      id: entry.folder.id,
      name: entry.folder.name,
      parentId: entry.folder.parentId,
      nodeCount: entry.nodes.length,
    })), { archivedBucket: group.isArchivedBucket === true, searchQuery: search ? args.normalizedQuery : '' });
    const visibleFolders = folderEntries.filter((entry) => visibleFolderKeys.has(entry.folder.id));
    const entryByIdentity = new Map(visibleFolders.map((entry) => [getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id), entry]));
    const childFolders = new Map<string, FolderProjection[]>();
    for (const entry of visibleFolders) {
      if (!entry.folder.parentId) continue;
      const parentKey = getSessionFolderIdentityKey(entry.scopeKey, entry.folder.parentId);
      const list = childFolders.get(parentKey) ?? [];
      list.push(entry);
      childFolders.set(parentKey, list);
    }
    const roots = normalizeFolderRoots(visibleFolders.map((entry) => ({ ...entry.folder, scopeKey: entry.scopeKey })))
      .map((folder) => entryByIdentity.get(getSessionFolderIdentityKey(folder.scopeKey ?? '', folder.id)))
      .filter((entry): entry is FolderProjection => Boolean(entry));
    const sessionsInFolders = new Set(visibleFolders.flatMap((entry) => entry.folder.sessionIds));
    const ungrouped = sourceNodes.filter((node) => !sessionsInFolders.has(node.session.id));

    const folderSessionsByIdentity = new Map<string, readonly Session[]>();
    const folderStack = roots.map((folder) => ({ folder, visited: false }));
    const seenFolderIds = new Set<string>();
    while (folderStack.length > 0) {
      const current = folderStack.pop();
      if (!current) continue;
      const identity = getSessionFolderIdentityKey(current.folder.scopeKey, current.folder.folder.id);
      if (!current.visited) {
        if (seenFolderIds.has(identity)) continue;
        seenFolderIds.add(identity);
        folderStack.push({ folder: current.folder, visited: true });
        for (const child of childFolders.get(identity) ?? []) folderStack.push({ folder: child, visited: false });
        continue;
      }
      const sessions = current.folder.nodes.flatMap((node) => {
        const range = indexed.subtreeRangeByNode.get(node);
        return range ? indexed.preorderIds.slice(range[0], range[1]).flatMap((id) => indexed.sessionsById.get(id) ?? []) : [node.session];
      });
      for (const child of childFolders.get(identity) ?? []) {
        sessions.push(...(folderSessionsByIdentity.get(getSessionFolderIdentityKey(child.scopeKey, child.folder.id)) ?? []));
      }
      folderSessionsByIdentity.set(identity, Object.freeze(sessions));
    }

    const renderedFolders = new Set<string>();
    const appendFolder = (entry: FolderProjection, parentPath: string): void => {
      const identity = getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id);
      if (renderedFolders.has(identity)) return;
      renderedFolders.add(identity);
      const displayName = parentPath ? `${parentPath} / ${entry.folder.name}` : entry.folder.name;
      const folderKey = `${groupKey}:folder:${identity}`;
      // An empty folder is always open, so the first session moved in shows.
      // Until the group's sessions have loaded, a folder only looks empty.
      const folderEmpty = groupLoaded && entry.nodes.length === 0 && (childFolders.get(identity)?.length ?? 0) === 0;
      const folderCollapsed = !search && !folderEmpty && args.collapsedFolders.has(entry.folder.id);
      const deleteSessions = folderSessionsByIdentity.get(identity) ?? [];
      // A collapsed parent hides child folders too. Reuse their indexed session
      // coverage, retaining tree roots so unread-subtask rules remain intact.
      const activityNodes = folderCollapsed && !group.isArchivedBucket
        ? selectFolderRootNodes([...new Set(deleteSessions.map((session) => session.id))], indexed.byId)
        : [];
      const authority = ownerKey ? args.folderAuthorityByOwner.get(ownerKey) : undefined;
      const dropEnabled = Boolean(ownerKey)
        && !group.isArchivedBucket
        && !isArchivedFolderScope(entry.scopeKey)
        && authority?.complete === true
        && authority.scopeKeys.includes(entry.scopeKey);
      push({
        kind: 'folder-header', key: folderKey, estimateSize: HEADER_ESTIMATE, depth: contentDepth, group,
        folder: entry.folder, displayName, scopeKey: entry.scopeKey, scopeDirectory: entry.scopeDirectory,
        ownerKey, nodes: entry.nodes, activityNodes, projectId, archived: group.isArchivedBucket === true,
        collapsed: folderCollapsed, forceExpanded: search, empty: folderEmpty,
        deleteSessions,
        subFolderCount: childFolders.get(identity)?.length ?? 0, dropEnabled,
      });
      if (ownerKey) folderDropTargets.push(Object.freeze({ rowKey: folderKey, scopeKey: entry.scopeKey, folderId: entry.folder.id, ownerKey, enabled: dropEnabled }));
      if (folderCollapsed) return;
      appendSessions({ nodes: entry.nodes, containerKey: folderKey, projectId, groupDirectory: entry.scopeDirectory ?? group.directory, ownerKey, selectionScopeKey: ownerKey, archived: group.isArchivedBucket === true, renderContext: 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth + 1 });
      for (const child of childFolders.get(identity) ?? []) appendFolder(child, displayName);
    };
    for (const folder of roots) appendFolder(folder, '');

    const sessionBatchSize = projectId ? args.sessionBatchSize : undefined;
    const initialLimit = limits?.initial ?? sessionBatchSize ?? (args.hideDirectoryControls ? 10 : SESSIONS_INITIAL_LIMIT);
    const increment = limits?.increment ?? sessionBatchSize ?? SESSIONS_INCREMENT;
    const requested = Math.max(initialLimit, args.visibleCountByContainer.get(groupKey) ?? initialLimit);
    // Pinned sessions are the user's own always-on shortlist: they stay
    // visible whatever the reveal limit is, and they do not spend it.
    const isPinnedNode = (entry: SidebarEntry): boolean => !isRunEntry(entry) && limits?.pinnedAlwaysVisible === true
      && isSessionPinned(pinned, entry.session.directory ?? group.directory, entry.session.id);
    // A run spends one slot of the reveal limit, whatever its lane count.
    const ungroupedEntries = collapseRunEntries(ungrouped, runIndex, group.isArchivedBucket === true);
    const limitedNodes = ungroupedEntries.filter((entry) => !isPinnedNode(entry));
    let budget = requested;
    const visibleEntries = group.isArchivedBucket || search
      ? ungroupedEntries
      : ungroupedEntries.filter((entry) => {
        if (isPinnedNode(entry)) return true;
        if (budget <= 0) return false;
        budget -= 1;
        return true;
      });
    const visibleUngrouped = visibleEntries.flatMap((entry) => isRunEntry(entry) ? entry.lanes : [entry]);
    appendSessions({ nodes: visibleUngrouped, containerKey: groupKey, projectId, groupDirectory: group.directory, ownerKey, selectionScopeKey: ownerKey, archived: group.isArchivedBucket === true, renderContext: limits?.renderContext ?? 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth });
    const remaining = ungroupedEntries.length - visibleEntries.length;
    const limitedVisibleCount = requested - budget;
    if (!search && !group.isArchivedBucket && remaining > 0) {
      push({ kind: 'show-control', key: `${groupKey}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey: groupKey, currentCount: limitedVisibleCount, increment, depth: contentDepth, flat });
    } else if (!search && !group.isArchivedBucket && limitedNodes.length > initialLimit && remaining === 0) {
      push({ kind: 'show-control', key: `${groupKey}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey: groupKey, currentCount: limitedVisibleCount, increment, depth: contentDepth, flat });
    }

    // An empty group lists nothing: its header has no chevron, and new
    // sessions start from the header's own button. Only the archive bucket
    // says it is empty.
    if (sourceNodes.length === 0 && visibleFolders.length === 0) {
      if (status && status.state !== 'ready') push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth, flat });
      else if (group.isArchivedBucket) push({ kind: 'empty', key: `${groupKey}:empty`, estimateSize: STATUS_ESTIMATE, emptyKind: 'archived', depth: contentDepth });
    } else if (status && status.state !== 'ready' && status.state !== 'loading') {
      push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth, flat });
    }
  };

  const appendActivityHeader = (activityKey: SessionSidebarActivityKey): boolean => {
    const collapsed = !search && args.collapsedActivities.has(activityKey);
    const rowIndex = rows.length;
    push({ kind: 'activity-header', key: `activity:${activityKey}:header`, estimateSize: HEADER_ESTIMATE, activityKey, collapsed, forceExpanded: search });
    stickyHeaders.push(Object.freeze({ rowIndex, kind: 'activity', id: activityKey }));
    return collapsed;
  };

  const timelineMode = args.viewMode === 'timeline';

  type ActivityRunEntry = { run: MultiRunSummary; items: SessionSidebarActivityItem[] };
  type ActivityEntry = SessionSidebarActivityItem | ActivityRunEntry;
  const isActivityRunEntry = (entry: ActivityEntry): entry is ActivityRunEntry => 'run' in entry;
  const collapseActivityItems = (items: readonly SessionSidebarActivityItem[]): ActivityEntry[] => {
    const entries = collapseRunEntries(items.map((item) => item.node), runIndex, false);
    const itemByNode = new Map(items.map((item) => [item.node, item]));
    return entries.flatMap((entry): ActivityEntry[] => {
      if (!isRunEntry(entry)) {
        const item = itemByNode.get(entry);
        return item ? [item] : [];
      }
      return [{ run: entry.run, items: entry.lanes.flatMap((lane) => itemByNode.get(lane) ?? []) }];
    });
  };
  const appendActivityRun = (
    entry: ActivityRunEntry,
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
  ): void => {
    const first = entry.items[0];
    if (!first) return;
    const lanes = entry.items.map((item) => item.node);
    const indexed = indexNodes(lanes);
    const selectionPoolOffset = selectionDescendantIds.length;
    selectionDescendantIds.push(...indexed.preorderIds);
    const ownerKey = getSessionFolderOwnerKey(first.projectId, first.groupDirectory);
    const metaById = new Map(entry.items.map((item) => [
      item.node.session.id,
      item.getSecondaryMeta ? item.getSecondaryMeta(item.node.session.id) : item.secondaryMeta,
    ]));
    const badgeScopesById = new Map(entry.items.map((item) => [item.node.session.id, item.blockingBadgeSessionScopes]));
    appendRun({ run: entry.run, lanes }, {
      nodes: lanes, containerKey, projectId: first.projectId, groupDirectory: first.groupDirectory,
      ownerKey, selectionScopeKey: null, archived: false, renderContext,
      getSecondaryMeta: (sessionId) => metaById.get(sessionId) ?? null,
      getBlockingBadgeSessionScopes: (sessionId) => badgeScopesById.get(sessionId),
      indexedNodes: indexed, selectionPoolOffset,
    });
  };

  const appendActivityItems = (
    items: readonly SessionSidebarActivityItem[],
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
    countMatches: (item: SessionSidebarActivityItem) => number = () => 1,
  ): void => {
    for (const entry of collapseActivityItems(items)) {
      if (isActivityRunEntry(entry)) {
        appendActivityRun(entry, containerKey, renderContext);
        if (search) searchMatchCount += entry.items.reduce((total, item) => total + countMatches(item), 0);
        continue;
      }
      const item = entry;
      const indexed = indexNodes([item.node]);
      const selectionPoolOffset = selectionDescendantIds.length;
      selectionDescendantIds.push(...indexed.preorderIds);
      const ownerKey = getSessionFolderOwnerKey(item.projectId, item.groupDirectory);
      appendSessions({
        nodes: [item.node], containerKey, projectId: item.projectId, groupDirectory: item.groupDirectory,
        // In work and the timeline lists carry no selection scope.
        ownerKey, selectionScopeKey: null, archived: false, renderContext,
        blockingBadgeSessionScopes: item.blockingBadgeSessionScopes,
        secondaryMeta: item.secondaryMeta, getSecondaryMeta: item.getSecondaryMeta, indexedNodes: indexed, selectionPoolOffset,
      });
      if (search) searchMatchCount += countMatches(item);
    }
  };

  if (args.chatGroup) {
    if (!search || groupSearchMatches(args.chatGroup) > 0) {
      const collapsed = appendActivityHeader('chats');
      if (!collapsed) {
        // Chats are one-line rows in both views, on a short page that pinned
        // chats do not spend; Tree gives them its state slot.
        appendGroup(args.chatGroup, 'activity:chats', null, true, {
          initial: CHATS_INITIAL_LIMIT, increment: CHATS_INCREMENT, pinnedAlwaysVisible: true,
          renderContext: timelineMode ? 'timeline-chat' : 'tree-chat',
        });
      }
    }
  }

  // Pinned and In work list sessions of every project together: two-line
  // rows with the project's icon in List, one-line rows in Tree unless the
  // user asked for detailed rows.
  const zoneRenderContext: SessionSidebarRenderContext = timelineMode || args.detailedZoneRows ? 'timeline-mixed' : 'mixed-compact';

  /**
   * A list that reveals `initial` entries, then `increment` more per Show
   * more. A run spends one slot; search lists everything.
   */
  const appendRevealedItems = (
    items: readonly SessionSidebarActivityItem[],
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
    initialLimit: number,
    increment: number,
  ): void => {
    const requested = Math.max(initialLimit, args.visibleCountByContainer.get(containerKey) ?? initialLimit);
    const entries = collapseActivityItems(items);
    const visibleEntries = search ? entries : entries.slice(0, requested);
    appendActivityItems(visibleEntries.flatMap((entry) => isActivityRunEntry(entry) ? entry.items : [entry]), containerKey, renderContext);
    if (search) return;
    if (entries.length > visibleEntries.length) push({ kind: 'show-control', key: `${containerKey}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey, currentCount: visibleEntries.length, increment, flat: true });
    else if (entries.length > initialLimit) push({ kind: 'show-control', key: `${containerKey}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey, currentCount: visibleEntries.length, increment, flat: true });
  };

  // Pinned and then In work sit under Chats and above the projects. A tree
  // is listed for its matching subsession too; the ancestors around it are
  // context, so only real matches count.
  const appendZone = (activityKey: 'pinned' | 'work', items: readonly SessionSidebarActivityItem[]): void => {
    if (items.length === 0) return;
    const collapsed = appendActivityHeader(activityKey);
    if (!collapsed) appendActivityItems(items, `activity:${activityKey}`, zoneRenderContext, (item) => item.searchMatchCount ?? countSessionTreeQueryMatches(item.node, args.normalizedQuery));
  };
  appendZone('pinned', args.pinnedItems ?? []);
  appendZone('work', args.workItems ?? []);

  if (timelineMode) {
    // One header per project, in the user's manual order, over its root
    // sessions from every worktree in lifecycle order. A session the Pinned
    // zone lists is left out of its project here; In work keeps it in both.
    const pinnedZoneIds = new Set((args.pinnedItems ?? []).map((item) => item.node.session.id));
    const itemsByProject = new Map<string, SessionSidebarActivityItem[]>();
    for (const item of args.timelineItems ?? []) {
      if (!item.projectId || isMovedToZone(item.node.session.id) || pinnedZoneIds.has(item.node.session.id)) continue;
      const list = itemsByProject.get(item.projectId);
      if (list) list.push(item);
      else itemsByProject.set(item.projectId, [item]);
    }
    for (const section of args.sections) {
      const projectId = section.project.id;
      const items = itemsByProject.get(projectId) ?? [];
      if (search && items.length === 0) continue;
      const collapsed = !search && args.collapsedProjects.has(projectId);
      const rowIndex = rows.length;
      push({ kind: 'project-header', key: `project:${projectId}:header`, estimateSize: HEADER_ESTIMATE, section, collapsed, forceExpanded: search });
      stickyHeaders.push(Object.freeze({ rowIndex, kind: 'project', id: projectId }));
      if (collapsed) continue;
      // A space without chats has no row of its own here, so its group header
      // stands in for it, with the space's state, until its first chat
      // (journey step 2: the space shows under its project at once).
      if (!search) {
        for (const group of section.groups) {
          if (!group.space || group.sessions.length > 0) continue;
          const groupKey = `${projectId}:${group.id}`;
          // While its chats load the space may well have some; a failed load
          // shows its line, as in the Tree, never an empty space.
          const status = args.groupStatusByKey.get(groupKey);
          if (status?.state === 'loading') continue;
          const empty = (!status || status.state === 'ready')
            && getSessionFolderScopes(group).every(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).length === 0);
          // Forced open: it hides nothing and, like every List row, is not dragged.
          push({ kind: 'group-header', key: `${groupKey}:header`, estimateSize: HEADER_ESTIMATE, group, groupKey, projectId, collapsed: false, forceExpanded: true, empty, allSessions: Object.freeze([]) });
          if (status && status.state !== 'ready') push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, flat: true });
        }
      }
      if (items.length > 0) {
        appendRevealedItems(items, timelineProjectContainerKey(projectId), 'timeline', SESSIONS_INITIAL_LIMIT, SESSIONS_INCREMENT);
        continue;
      }
      const mainGroup = section.groups.find((group) => group.isMain);
      if (!mainGroup) continue;
      const groupKey = `${projectId}:${mainGroup.id}`;
      const status = args.groupStatusByKey.get(groupKey);
      if (status && status.state !== 'ready') push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group: mainGroup, groupKey, flat: true });
    }
  }

  let projectSections = timelineMode ? [] : args.singleProjectMode
    ? args.sections.filter((section) => section.project.id === args.singleProjectId)
    : [...args.sections];
  if (args.showOnlyMainWorkspace) {
    const active = projectSections.find((section) => section.project.id === args.activeProjectId) ?? projectSections[0];
    projectSections = active ? [active] : [];
  }
  for (const section of projectSections) {
    const descriptors = buildGroupRenderDescriptors(section, { mainWorkspaceOnly: args.showOnlyMainWorkspace });
    // A project whose only matches moved to a zone shows no empty header.
    if (search && !descriptors.some((descriptor) => groupSearchMatches(descriptor.group) > 0)) continue;
    const projectCollapsed = !search && !args.singleProjectMode && !args.showOnlyMainWorkspace && args.collapsedProjects.has(section.project.id);
    if (!args.showOnlyMainWorkspace) {
      const rowIndex = rows.length;
      push({ kind: 'project-header', key: `project:${section.project.id}:header`, estimateSize: HEADER_ESTIMATE, section, collapsed: projectCollapsed, forceExpanded: search });
      stickyHeaders.push(Object.freeze({ rowIndex, kind: 'project', id: section.project.id }));
    }
    if (projectCollapsed) continue;
    for (const descriptor of descriptors) appendGroup(descriptor.group, descriptor.groupKey, descriptor.projectId, descriptor.hideGroupLabel);
  }

  if (rows.length === 0) {
    push({ kind: 'empty', key: search ? 'sidebar:search-empty' : 'sidebar:empty', estimateSize: 72, emptyKind: search ? 'search' : 'sidebar' });
  }
  const rowIndexByKey = new Map<string, number>();
  rows.forEach((row, index) => rowIndexByKey.set(row.key, index));
  return Object.freeze({
    rows: Object.freeze(rows),
    selectionEntries: Object.freeze(selectionEntries),
    selectionDescendantIds: Object.freeze(selectionDescendantIds),
    rowIndexByKey,
    stickyHeaders: Object.freeze(stickyHeaders),
    folderDropTargets: Object.freeze(folderDropTargets),
    folderAuthorityByOwner: args.folderAuthorityByOwner,
    sessionById,
    searchMatchCount: search ? searchMatchCount : 0,
  });
};
