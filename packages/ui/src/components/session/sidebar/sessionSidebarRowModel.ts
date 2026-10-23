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
import { computeSessionTreeGuides, type SessionTreeGuide } from './sessions/sessionTreeGeometry';
import { countSessionTreeQueryMatches } from './recent/activitySections';
import { EMPTY_MULTI_RUN_INDEX, type MultiRunIndex, type MultiRunSummary } from '@/lib/multirun/runs';
import { isWorktreeWorkGroup, worktreeFolderMemberId } from './works/sidebarWorks';
import type { SessionDraft } from '@/stores/useSessionDraftsStore';

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

/**
 * One entry of the In work block or of the list by time: a session work's
 * row (the session with what grew out of it nested under it), or a worktree
 * work, drawn as its group row with its sessions under it.
 */
export type SessionSidebarWorkEntry =
  | { kind: 'session'; item: SessionSidebarActivityItem }
  | { kind: 'worktree'; groupKey: string; projectId: string; group: SessionGroup }
  // A project root's draft, in the list by time; a worktree's drafts sit in its group.
  | { kind: 'draft'; draft: SessionDraft; projectId: string };

// 'timeline' is the one list of every project's works when the sidebar groups
// them by time.
export type SessionSidebarActivityKey = 'pinned' | 'work' | 'chats' | 'timeline';

/** Activity sections; the display menu's Collapse all / Expand all drive them with the projects. */
export const SIDEBAR_ACTIVITY_KEYS: readonly SessionSidebarActivityKey[] = ['chats', 'pinned', 'work', 'timeline'];

// 'project' is a one-line file tree row under a project. Rows of zones that
// mix projects (Pinned, In work, the list by time) are 'mixed-compact', one
// line with the project's icon before the title, or with detailed rows
// 'timeline-mixed', two lines with no left gutter and the status on the
// right, the project's icon opening the second. 'tree-chat' is a Chats row.
export type SessionSidebarRenderContext = 'project' | 'timeline-mixed' | 'mixed-compact' | 'tree-chat';

/**
 * Rows that keep the tree's geometry and its slot left of the title, which
 * shows the live state: every row but the detailed zone rows, which are flat
 * and show the state on the right.
 */
export const hasTreeSlotContext = (context: SessionSidebarRenderContext): boolean => context !== 'timeline-mixed';

/** Rows that render through `SessionTimelineRowBody` with two lines. */
export const isMultiLineTimelineContext = (context: SessionSidebarRenderContext): boolean => context === 'timeline-mixed';

/** Zone rows never expand a run: a run row opens its overview instead. */
const isNeverExpandedContext = (context: SessionSidebarRenderContext): boolean => (
  context === 'timeline-mixed' || context === 'mixed-compact'
);

export type SessionSidebarGroupStatus = {
  state: 'ready' | 'loading' | 'load-failed' | 'initialization-failed' | 'permission-denied';
  directory: string | null;
  canGrantAccess: boolean;
};

export type SessionSidebarOwnerAuthority = {
  scopeKeys: readonly string[];
  complete: boolean;
};

// `treeGuides`: the guide lines a Tree row draws over itself, framing the
// children of an open worktree, folder, session or run.
type RowBase = { key: string; estimateSize: number; treeGuides?: readonly SessionTreeGuide[] };

export type SessionSidebarRow =
  | (RowBase & { kind: 'activity-header'; activityKey: SessionSidebarActivityKey; collapsed: boolean; forceExpanded: boolean })
  | (RowBase & { kind: 'project-header'; section: ProjectSection; collapsed: boolean; forceExpanded: boolean })
  // `empty`: nothing to list under the header, so it offers no chevron.
  // `depth`: its tree level (1 inside a folder). `mixed`: listed among other
  // projects' works (In work, the list by time), so it names its project.
  // `sortable`: under its project, where worktrees take the manual drag order.
  | (RowBase & { kind: 'group-header'; group: SessionGroup; groupKey: string; projectId: string | null; collapsed: boolean; forceExpanded: boolean; empty: boolean; allSessions: readonly Session[]; depth: number; mixed: boolean; sortable: boolean })
  | (RowBase & { kind: 'folder-header'; depth: number; group: SessionGroup; folder: SessionFolder; displayName: string; scopeKey: string; scopeDirectory: string | null; ownerKey: string | null; nodes: readonly SessionNode[]; activityNodes: readonly SessionNode[]; projectId: string | null; archived: boolean; collapsed: boolean; forceExpanded: boolean; empty: boolean; deleteSessions: readonly Session[]; subFolderCount: number; dropEnabled: boolean })
  | (RowBase & { kind: 'session'; node: SessionNode; blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[]; depth: number; projectId: string | null; groupDirectory: string | null; ownerKey: string | null; selectionScopeKey: string | null; archived: boolean; renderContext: SessionSidebarRenderContext; secondaryMeta: SessionSidebarActivityItem['secondaryMeta'] })
  // A multi-run: one derived parent row over its member sessions. It is not a
  // session, so it never enters selection, and its lanes render as session
  // rows one level deeper when it is expanded.
  // A new session's draft the user left before sending, where its session
  // would go. `mixed`: in a zone, so it names its project.
  | (RowBase & { kind: 'draft'; draft: SessionDraft; depth: number; projectId: string | null; mixed: boolean })
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
  sections: readonly ProjectSection[];
  authoritativeSections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  /** Pinned sessions, already ordered and search-filtered; they stay under their project too. */
  pinnedItems?: readonly SessionSidebarActivityItem[];
  /** The works in the In work block, in lifecycle order. */
  workEntries?: readonly SessionSidebarWorkEntry[];
  /**
   * Set when the sidebar groups by time: every other work of every project,
   * in one list under one zone header, in place of the project headers.
   */
  timeEntries?: readonly SessionSidebarWorkEntry[] | null;
  /** Drafts of new sessions by the group their session would go to, newest first. */
  draftsByGroupKey?: ReadonlyMap<string, readonly SessionDraft[]>;
  /** Root sessions and worktree groups of the works In work lists, left out of their project. */
  movedSessionIds?: ReadonlySet<string>;
  movedGroupKeys?: ReadonlySet<string>;
  /** Every session listed in the Pinned or In work zone, which search lists there only. */
  zoneSessionIds?: ReadonlySet<string>;
  /** Rows that mix projects (Pinned, In work, the list by time): two lines when set, one otherwise. */
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
const EMPTY_DRAFTS: readonly SessionDraft[] = [];
// One line: the 20px line, 6px above and below, and the 1px margin each side
// the row renderer gives session rows (`my-px`).
const SESSION_ESTIMATE = 34;
const TIMELINE_SESSION_ESTIMATE = 52;
const estimateSessionRow = (context: SessionSidebarRenderContext): number => (
  isMultiLineTimelineContext(context) ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE
);
// Chats open on a short page, with pinned chats on top of it.
const CHATS_INITIAL_LIMIT = 3;
const CHATS_INCREMENT = 7;
// Project and worktree lists reveal 7 sessions per page.
const SESSIONS_INITIAL_LIMIT = 7;
const SESSIONS_INCREMENT = 7;

const HEADER_ESTIMATE = 32;
const STATUS_ESTIMATE = 28;

/**
 * A row's level in the drawn tree, or null for a row outside it: headers of
 * projects and zones, Show more and status lines, and the detailed zone rows.
 * Worktree, space and archive headers open the tree at level 0.
 */
const treeLevelOf = (row: SessionSidebarRow): number | null => {
  switch (row.kind) {
    case 'group-header': return row.depth;
    case 'folder-header': return row.depth;
    case 'draft': return row.depth;
    case 'session':
    case 'run': return hasTreeSlotContext(row.renderContext) ? row.depth : null;
    default: return null;
  }
};

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

/** A worktree work the user filed into one of its project's folders. */
type WorktreeInFolder = { group: SessionGroup; groupKey: string };

/** Where a group's rows go: under its project, in a zone, or inside a folder. */
type GroupPlacement = { keyPrefix: string; depth: number; mixed: boolean; sortable: boolean };
const PROJECT_PLACEMENT: GroupPlacement = { keyPrefix: '', depth: 0, mixed: false, sortable: true };

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
  const movedSessionIds = args.movedSessionIds ?? EMPTY_ZONE_SESSION_IDS;
  const movedGroupKeys = args.movedGroupKeys ?? EMPTY_ZONE_SESSION_IDS;
  // A work In work lists leaves its project, unless the user keeps it there
  // too (the collection then passes no moved sets). Search lists every zone
  // session once, in its zone, so its count and rows agree.
  const isMovedToZone = (sessionId: string): boolean => movedSessionIds.has(sessionId) || (search && inZone.has(sessionId));
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
    // Zone rows never expand a run; the overview lists the lanes.
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
      estimateSize: estimateSessionRow(options.renderContext),
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
        estimateSize: estimateSessionRow(options.renderContext),
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
    placement: GroupPlacement = PROJECT_PLACEMENT,
    // The project's worktree groups by folder member id, for the root group,
    // whose folders may hold whole worktrees.
    worktreesByMemberId?: ReadonlyMap<string, WorktreeInFolder>,
  ): void => {
    // Row keys carry the placement, so a worktree listed in In work and kept
    // under its project too does not collide; collapse and Show more state
    // stay keyed by the group alone and are shared.
    const rowKeyBase = `${placement.keyPrefix}${groupKey}`;
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
    const contentDepth = hideHeader ? 0 : placement.depth + 1;
    const status = args.groupStatusByKey.get(groupKey);
    const groupLoaded = !status || status.state === 'ready';
    // Nothing to list: no sessions, no folders, and no loading or failure
    // line to show.
    // Drafts are left out of a search, which matches sessions.
    const groupDrafts = search ? EMPTY_DRAFTS : args.draftsByGroupKey?.get(groupKey) ?? EMPTY_DRAFTS;
    const empty = sourceNodes.length === 0
      && groupDrafts.length === 0
      && groupLoaded
      && getSessionFolderScopes(group).every(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).length === 0);
    const appendDrafts = (): void => {
      for (const draft of groupDrafts) {
        push({ kind: 'draft', key: keyFor(`${rowKeyBase}:draft:${draft.id}`), estimateSize: SESSION_ESTIMATE, draft, depth: contentDepth, projectId, mixed: false });
      }
    };
    if (!hideHeader) {
      const allSessions = indexed.preorderIds.flatMap((id) => indexed.sessionsById.get(id) ?? []);
      push({ kind: 'group-header', key: `${rowKeyBase}:header`, estimateSize: isWorktreeWorkGroup(group) ? SESSION_ESTIMATE : HEADER_ESTIMATE, group, groupKey, projectId, collapsed: storedCollapsed && !empty, forceExpanded: search, empty, allSessions: Object.freeze(allSessions), depth: placement.depth, mixed: placement.mixed, sortable: placement.sortable });
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
      const folderKey = `${rowKeyBase}:folder:${identity}`;
      // An empty folder is always open, so the first session moved in shows.
      // Until the group's sessions have loaded, a folder only looks empty.
      const folderWorktrees = worktreesByMemberId
        ? entry.folder.sessionIds.flatMap((memberId) => worktreesByMemberId.get(memberId) ?? [])
        : [];
      const folderEmpty = groupLoaded && entry.nodes.length === 0 && folderWorktrees.length === 0 && (childFolders.get(identity)?.length ?? 0) === 0;
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
      for (const worktree of folderWorktrees) {
        appendGroup(worktree.group, worktree.groupKey, projectId, false, undefined, {
          keyPrefix: '', depth: contentDepth + 1, mixed: false, sortable: false,
        });
      }
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
    // A new work in the project root opens its list, newest first; a draft in
    // a worktree closes the worktree's list, after what was already sent there.
    if (group.isMain) appendDrafts();
    appendSessions({ nodes: visibleUngrouped, containerKey: rowKeyBase, projectId, groupDirectory: group.directory, ownerKey, selectionScopeKey: ownerKey, archived: group.isArchivedBucket === true, renderContext: limits?.renderContext ?? 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth });
    if (!group.isMain) appendDrafts();
    const remaining = ungroupedEntries.length - visibleEntries.length;
    const limitedVisibleCount = requested - budget;
    if (!search && !group.isArchivedBucket && remaining > 0) {
      push({ kind: 'show-control', key: `${rowKeyBase}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey: groupKey, currentCount: limitedVisibleCount, increment, depth: contentDepth, flat: false });
    } else if (!search && !group.isArchivedBucket && limitedNodes.length > initialLimit && remaining === 0) {
      push({ kind: 'show-control', key: `${rowKeyBase}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey: groupKey, currentCount: limitedVisibleCount, increment, depth: contentDepth, flat: false });
    }

    // An empty group lists nothing: its header has no chevron, and new
    // sessions start from the header's own button. Only the archive bucket
    // says it is empty.
    if (sourceNodes.length === 0 && visibleFolders.length === 0) {
      if (status && status.state !== 'ready') push({ kind: 'status', key: `${rowKeyBase}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth });
      else if (group.isArchivedBucket) push({ kind: 'empty', key: `${rowKeyBase}:empty`, estimateSize: STATUS_ESTIMATE, emptyKind: 'archived', depth: contentDepth });
    } else if (status && status.state !== 'ready' && status.state !== 'loading') {
      push({ kind: 'status', key: `${rowKeyBase}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth });
    }
  };

  const appendActivityHeader = (activityKey: SessionSidebarActivityKey): boolean => {
    const collapsed = !search && args.collapsedActivities.has(activityKey);
    const rowIndex = rows.length;
    push({ kind: 'activity-header', key: `activity:${activityKey}:header`, estimateSize: HEADER_ESTIMATE, activityKey, collapsed, forceExpanded: search });
    stickyHeaders.push(Object.freeze({ rowIndex, kind: 'activity', id: activityKey }));
    return collapsed;
  };

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

  // Activity items are only listed in zones, which count real matches only.
  const countZoneMatches = (item: SessionSidebarActivityItem): number => (
    item.searchMatchCount ?? countSessionTreeQueryMatches(item.node, args.normalizedQuery)
  );
  const appendActivityItems = (
    items: readonly SessionSidebarActivityItem[],
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
  ): void => {
    for (const entry of collapseActivityItems(items)) {
      if (isActivityRunEntry(entry)) {
        appendActivityRun(entry, containerKey, renderContext);
        if (search) searchMatchCount += entry.items.reduce((total, item) => total + countZoneMatches(item), 0);
        continue;
      }
      const item = entry;
      const indexed = indexNodes([item.node]);
      const selectionPoolOffset = selectionDescendantIds.length;
      selectionDescendantIds.push(...indexed.preorderIds);
      const ownerKey = getSessionFolderOwnerKey(item.projectId, item.groupDirectory);
      appendSessions({
        nodes: [item.node], containerKey, projectId: item.projectId, groupDirectory: item.groupDirectory,
        // Zone lists carry no selection scope.
        ownerKey, selectionScopeKey: null, archived: false, renderContext,
        blockingBadgeSessionScopes: item.blockingBadgeSessionScopes,
        secondaryMeta: item.secondaryMeta, getSecondaryMeta: item.getSecondaryMeta, indexedNodes: indexed, selectionPoolOffset,
      });
      if (search) searchMatchCount += countZoneMatches(item);
    }
  };

  if (args.chatGroup) {
    if (!search || groupSearchMatches(args.chatGroup) > 0) {
      const collapsed = appendActivityHeader('chats');
      if (!collapsed) {
        // Chats are one-line rows with the tree's state slot, on a short page
        // that pinned chats do not spend.
        appendGroup(args.chatGroup, 'activity:chats', null, true, {
          initial: CHATS_INITIAL_LIMIT, increment: CHATS_INCREMENT, pinnedAlwaysVisible: true,
          renderContext: 'tree-chat',
        });
      }
    }
  }

  // Pinned, In work and the list by time mix every project's works: one-line
  // rows with the project's icon, two lines when the user asked for detailed rows.
  const zoneRenderContext: SessionSidebarRenderContext = args.detailedZoneRows ? 'timeline-mixed' : 'mixed-compact';

  /**
   * Works in a zone, in order. Consecutive session works go through one call,
   * so the lanes of a multi-run among them still collapse into one run row; a
   * worktree work is its group row with its sessions under it, naming its
   * project and kept out of the drag sort. A group counts its own search
   * matches.
   */
  const appendWorkEntries = (entries: readonly SessionSidebarWorkEntry[], containerKey: string): void => {
    let pending: SessionSidebarActivityItem[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      appendActivityItems(pending, containerKey, zoneRenderContext);
      pending = [];
    };
    for (const entry of entries) {
      if (entry.kind === 'session') {
        pending.push(entry.item);
        continue;
      }
      flush();
      if (entry.kind === 'draft') {
        push({ kind: 'draft', key: keyFor(`${containerKey}:draft:${entry.draft.id}`), estimateSize: SESSION_ESTIMATE, draft: entry.draft, depth: 0, projectId: entry.projectId, mixed: true });
        continue;
      }
      appendGroup(entry.group, entry.groupKey, entry.projectId, false, undefined, {
        keyPrefix: `${containerKey}:`, depth: 0, mixed: true, sortable: false,
      });
    }
    flush();
  };

  // Pinned and then In work sit under Chats and above the projects. A tree
  // is listed for its matching subsession too; the ancestors around it are
  // context, so only real matches count.
  const pinnedItems = args.pinnedItems ?? [];
  if (pinnedItems.length > 0) {
    const collapsed = appendActivityHeader('pinned');
    if (!collapsed) appendActivityItems(pinnedItems, 'activity:pinned', zoneRenderContext);
  }
  // A zone a search left empty shows no header: search filters the entries
  // the collection passes, and a worktree work's group may still match nothing.
  const matchesSearch = (entry: SessionSidebarWorkEntry): boolean => (
    !search || entry.kind === 'session' || (entry.kind === 'worktree' && groupSearchMatches(entry.group) > 0)
  );
  const workEntries = (args.workEntries ?? []).filter(matchesSearch);
  if (workEntries.length > 0) {
    const collapsed = appendActivityHeader('work');
    if (!collapsed) appendWorkEntries(workEntries, 'activity:work');
  }

  // Keep the selected project's picker even when search has no matches there.
  const selectedSection = args.singleProjectMode
    ? args.sections.find((section) => section.project.id === args.singleProjectId)
      ?? args.authoritativeSections.find((section) => section.project.id === args.singleProjectId)
    : undefined;
  const sections = args.singleProjectMode ? selectedSection ? [selectedSection] : [] : args.sections;

  const timeEntries = args.singleProjectMode ? null : args.timeEntries ?? null;
  if (timeEntries) {
    // One list of every other work of every project, most recent first, under
    // one zone header. It is virtualized, so it reveals all of them at once.
    const entries = timeEntries.filter(matchesSearch);
    if (entries.length > 0) {
      const collapsed = appendActivityHeader('timeline');
      if (!collapsed) appendWorkEntries(entries, 'activity:timeline');
    }
    // The list has no project headers to hold a load status, so it closes
    // with one line per distinct status of a project it lists nothing for,
    // as a project header would: one while any loads, and one per failure,
    // whose Retry reloads that directory or the global list.
    if (!search && !(entries.length > 0 && args.collapsedActivities.has('timeline'))) {
      const listedProjects = new Set(timeEntries.map((entry) => entry.kind === 'session' ? entry.item.projectId : entry.projectId));
      const shown = new Set<string>();
      for (const section of args.sections) {
        if (listedProjects.has(section.project.id)) continue;
        const mainGroup = section.groups.find((group) => group.isMain);
        if (!mainGroup) continue;
        const groupKey = `${section.project.id}:${mainGroup.id}`;
        const status = args.groupStatusByKey.get(groupKey);
        if (!status || status.state === 'ready') continue;
        const identity = status.state === 'loading' ? 'loading' : `${status.state}:${status.directory ?? ''}`;
        if (shown.has(identity)) continue;
        shown.add(identity);
        push({ kind: 'status', key: `activity:timeline:status:${groupKey}`, estimateSize: STATUS_ESTIMATE, status, group: mainGroup, groupKey, flat: true });
      }
    }
  }

  let projectSections = timeEntries ? [] : [...sections];
  if (args.showOnlyMainWorkspace) {
    const active = projectSections.find((section) => section.project.id === args.activeProjectId) ?? projectSections[0];
    projectSections = active ? [active] : [];
  }
  for (const section of projectSections) {
    const descriptors = buildGroupRenderDescriptors(section, { mainWorkspaceOnly: args.showOnlyMainWorkspace });
    // A project whose only matches moved to a zone shows no empty header.
    if (search && !descriptors.some((descriptor) => !movedGroupKeys.has(descriptor.groupKey) && groupSearchMatches(descriptor.group) > 0)) continue;
    const projectCollapsed = !search && !args.singleProjectMode && !args.showOnlyMainWorkspace && args.collapsedProjects.has(section.project.id);
    if (!args.showOnlyMainWorkspace) {
      const rowIndex = rows.length;
      push({ kind: 'project-header', key: `project:${section.project.id}:header`, estimateSize: HEADER_ESTIMATE, section, collapsed: projectCollapsed, forceExpanded: search });
      stickyHeaders.push(Object.freeze({ rowIndex, kind: 'project', id: section.project.id }));
    }
    if (projectCollapsed) continue;
    // Worktrees filed into a folder of the project root render inside it, and
    // only there; one filed into a folder that is gone stays under the project.
    // A search lists them as plain worktrees: folders show only where their
    // own sessions match.
    const worktreesByMemberId = new Map<string, WorktreeInFolder>();
    const rootGroup = search ? undefined : descriptors.find((descriptor) => descriptor.group.isMain)?.group;
    const rootFolderMembers = new Set(rootGroup
      ? getSessionFolderScopes(rootGroup).flatMap(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).flatMap((folder) => folder.sessionIds))
      : []);
    for (const descriptor of descriptors) {
      const memberId = isWorktreeWorkGroup(descriptor.group) ? worktreeFolderMemberId(descriptor.group.directory) : null;
      if (memberId && rootFolderMembers.has(memberId) && !movedGroupKeys.has(descriptor.groupKey)) {
        worktreesByMemberId.set(memberId, { group: descriptor.group, groupKey: descriptor.groupKey });
      }
    }
    const filedGroupKeys = new Set([...worktreesByMemberId.values()].map((entry) => entry.groupKey));
    for (const descriptor of descriptors) {
      // A worktree work In work lists has left its project.
      if (movedGroupKeys.has(descriptor.groupKey) || filedGroupKeys.has(descriptor.groupKey)) continue;
      appendGroup(descriptor.group, descriptor.groupKey, descriptor.projectId, descriptor.hideGroupLabel, undefined, PROJECT_PLACEMENT,
        descriptor.group.isMain ? worktreesByMemberId : undefined);
    }
  }

  if (rows.length === 0 || (search && args.singleProjectMode && searchMatchCount === 0)) {
    push({ kind: 'empty', key: search ? 'sidebar:search-empty' : 'sidebar:empty', estimateSize: 72, emptyKind: search ? 'search' : 'sidebar' });
  }
  const guides = computeSessionTreeGuides(rows.map(treeLevelOf));
  guides.forEach((treeGuides, index) => {
    const row = rows[index];
    if (treeGuides && row) rows[index] = Object.freeze({ ...row, treeGuides });
  });
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
