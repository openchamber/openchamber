import type { Session } from '@/lib/opencode/model';
import type { SessionRowLines } from '@/stores/useSessionDisplayStore';
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
import {
  CLASSIC_SIDEBAR_LAYOUT,
  isSidebarAttentionZoneKey,
  SIDEBAR_SECTION_KEYS,
  type SidebarAttentionZoneKey,
  type SidebarSectionKey,
  type SidebarZoneKey,
  type TimelineChatsPlacement,
} from '@/stores/sidebarLayout';

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
 * Zones with a header of their own: Chats, Pinned, In work, the attention
 * zones, `all`, the List view's heading over the projects when Chats are
 * among them, or over its one combined list, and `timeline`, the List view's
 * one list of every project's sessions when it sorts them by time.
 */
export type SessionSidebarActivityKey = SidebarZoneKey | 'all' | 'timeline';

/** Activity sections; the display menu's Collapse all / Expand all drive them with the projects. */
export const SIDEBAR_ACTIVITY_KEYS: readonly SessionSidebarActivityKey[] = [
  ...SIDEBAR_SECTION_KEYS.filter((key): key is SidebarZoneKey => key !== 'projects'),
  'all',
  'timeline',
];

// 'project' is a one-line file tree row of the grouped view. Timeline rows
// have no left gutter and carry their status on the right: 'timeline' is a
// two-line row under its project header; 'timeline-mixed' is the same row in
// the zones, where sessions of every project mix, so its second line opens
// with the project's icon; 'timeline-by-time' is the row of the List view's
// list by time, three lines with the project's name on the first;
// 'mixed-compact' is the two-line row on one line, the Tree view's default
// for the zones; 'mixed-flat' is the List view's one-line zone row, flat with
// the project's icon before the title; 'timeline-chat' is a one-line List row
// under a header (Chats, and projects with one line per session), 'tree-chat'
// the Chats row in Tree (its body opens a second line when Chats rows take
// two lines, keeping the tree slot and this context).
export type SessionSidebarRenderContext = 'project' | 'timeline' | 'timeline-mixed' | 'timeline-by-time' | 'mixed-compact' | 'mixed-flat' | 'timeline-chat' | 'tree-chat';

/**
 * Rows that keep the tree's geometry and its slot left of the title, which
 * shows the live state: everything in Tree but the detailed zone rows. List
 * rows are flat and show the state on the right.
 */
export const hasTreeSlotContext = (context: SessionSidebarRenderContext): boolean => (
  context === 'project' || context === 'mixed-compact' || context === 'tree-chat'
);

/** Rows that render through `SessionTimelineRowBody` with two or three lines. */
export const isMultiLineTimelineContext = (context: SessionSidebarRenderContext): boolean => (
  context === 'timeline' || context === 'timeline-mixed' || context === 'timeline-by-time'
);

/** Flat zone and timeline rows never expand: a run row opens its overview instead. */
const isNeverExpandedContext = (context: SessionSidebarRenderContext): boolean => (
  isMultiLineTimelineContext(context) || context === 'mixed-compact' || context === 'mixed-flat' || context === 'timeline-chat'
);

/** Zone rows, where sessions of every project mix. */
export const isMixedZoneContext = (context: SessionSidebarRenderContext): boolean => (
  context === 'timeline-mixed' || context === 'timeline-by-time' || context === 'mixed-compact' || context === 'mixed-flat'
);

export type SessionSidebarViewMode = 'projects' | 'timeline';

/** How the List view lays out project sessions: under their project, or in one list by time. */
export type SessionSidebarListGrouping = 'project' | 'time';

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
  // `count`: sessions in an attention zone, shown after its title.
  | (RowBase & { kind: 'activity-header'; activityKey: SessionSidebarActivityKey; collapsed: boolean; forceExpanded: boolean; count?: number })
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

/** The first header of a section, which dragging a section header sorts by. */
export type SessionSidebarSectionHeader = { key: SidebarSectionKey; rowKey: string; dragId: string };

/** A top-level session row in drawn order, with the list it sits in. */
export type SessionSidebarNavigationEntry = { sessionId: string; directory: string | null; containerKey: string };

export type SessionSidebarRowModel = {
  rows: readonly SessionSidebarRow[];
  sectionHeaders: readonly SessionSidebarSectionHeader[];
  navigationEntries: readonly SessionSidebarNavigationEntry[];
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
  /**
   * Timeline only. `time` replaces the project headers with one list of
   * every project's sessions under a single zone header, in lifecycle order
   * with no reveal limit; sessions listed in Pinned or In work leave it.
   */
  listGrouping?: SessionSidebarListGrouping;
  sections: readonly ProjectSection[];
  authoritativeSections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  /** Every non-archived root project session with its project, in lifecycle order. */
  timelineItems?: readonly SessionSidebarActivityItem[];
  /** Projects the List view leaves out of All sessions; their sessions are already gone from timelineItems. */
  hiddenFromAllProjectIds?: ReadonlySet<string>;
  /**
   * Pinned sessions and sessions in work, already ordered and
   * search-filtered. Each zone renders as its own block at the top, and its
   * sessions stay under their project too. Search lists each of them once,
   * in its zone.
   */
  pinnedItems?: readonly SessionSidebarActivityItem[];
  workItems?: readonly SessionSidebarActivityItem[];
  /** Sessions the attention zones pulled out by their live state, ordered and search-filtered. */
  attentionItems?: ReadonlyMap<SidebarAttentionZoneKey, readonly SessionSidebarActivityItem[]>;
  /** Every session listed in a zone. */
  zoneSessionIds?: ReadonlySet<string>;
  /** The order sections are drawn in; the classic order without it. */
  sectionOrder?: readonly SidebarSectionKey[];
  /**
   * The List view's layout. Chats as a group sit among the projects at
   * `chatsGroupIndex`; without project groups, `timelineItems` already holds
   * the chats that join the one combined list.
   */
  timelineLayout?: { chats: TimelineChatsPlacement; projectGroups: boolean; compactRows: boolean; chatsGroupIndex: number };
  /** Pinned and In work rows in the Tree view: two lines with branch, PR and model when set, one otherwise. */
  zoneRowLines?: SessionRowLines;
  /** Chats rows: two lines when set, one otherwise; Tree Chats keep their tree slot either way. */
  chatsRowLines?: SessionRowLines;
  /** Session rows inside Tree projects: two lines when set, one otherwise; the rows keep the tree either way. */
  projectRowLines?: SessionRowLines;
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
// A third fixed line: the 20px title line and its 1px gap.
const TIMELINE_THREE_LINE_ESTIMATE = TIMELINE_SESSION_ESTIMATE + 21;
const estimateSessionRow = (context: SessionSidebarRenderContext): number => {
  if (context === 'timeline-by-time') return TIMELINE_THREE_LINE_ESTIMATE;
  return isMultiLineTimelineContext(context) ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE;
};
// Chats open on a short page in both views, with pinned chats on top of it.
const CHATS_INITIAL_LIMIT = 3;
const CHATS_INCREMENT = 7;
// Project and worktree lists reveal 7 sessions per page in both views.
const SESSIONS_INITIAL_LIMIT = 7;
const SESSIONS_INCREMENT = 7;
// The List view's one combined list reveals 20 at a time.
const COMBINED_INITIAL_LIMIT = 20;
const COMBINED_INCREMENT = 20;
const DEFAULT_TIMELINE_LAYOUT: NonNullable<SessionSidebarRowModelArgs['timelineLayout']> = {
  chats: 'section', projectGroups: true, compactRows: false, chatsGroupIndex: 0,
};

/** The sortable id of a zone header. */
export const sectionDragId = (key: SessionSidebarActivityKey): string => `zone:${key}`;

/** Zones of sessions the user does not follow; they open on a page of 7. */
const isOtherSessionsZone = (key: SidebarZoneKey): boolean => key.startsWith('other-');

/** Show more / Show fewer state of a project's session list in the timeline. */
export const timelineProjectContainerKey = (projectId: string): string => `timeline-project:${projectId}`;
const HEADER_ESTIMATE = 32;
const STATUS_ESTIMATE = 28;

/**
 * A row's level in the drawn tree, or null for a row outside it: headers of
 * projects and zones, Show more and status lines, and the flat List rows.
 * Worktree, space and archive headers open the tree at level 0.
 */
const treeLevelOf = (row: SessionSidebarRow): number | null => {
  switch (row.kind) {
    case 'group-header': return 0;
    case 'folder-header': return row.depth;
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

export const buildSessionSidebarRowModel = (args: SessionSidebarRowModelArgs): SessionSidebarRowModel => {
  const rows: SessionSidebarRow[] = [];
  const selectionEntries: SessionRowOrderEntry[] = [];
  const selectionDescendantIds: string[] = [];
  const stickyHeaders: SessionSidebarStickyHeader[] = [];
  const folderDropTargets: SessionSidebarFolderTarget[] = [];
  const sectionHeaders: SessionSidebarSectionHeader[] = [];
  const navigationEntries: SessionSidebarNavigationEntry[] = [];
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
        estimateSize: estimateFor(options.renderContext),
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
      if (!options.archived && !current.node.session.parentID) {
        navigationEntries.push(Object.freeze({ sessionId: current.node.session.id, directory, containerKey: options.containerKey }));
      }
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

  const appendActivityHeader = (activityKey: SessionSidebarActivityKey, count?: number): boolean => {
    const collapsed = !search && args.collapsedActivities.has(activityKey);
    const rowIndex = rows.length;
    push({ kind: 'activity-header', key: `activity:${activityKey}:header`, estimateSize: HEADER_ESTIMATE, activityKey, collapsed, forceExpanded: search, count });
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

  const timelineLayout = args.timelineLayout ?? DEFAULT_TIMELINE_LAYOUT;
  const chatsRowLines = args.chatsRowLines ?? 'one';
  const projectRowLines = args.projectRowLines ?? 'one';
  // Two-line Chats rows in Tree keep their 'tree-chat' context (and its tree
  // slot), and two-line project rows keep 'project': only their size changes.
  const estimateFor = (context: SessionSidebarRenderContext): number => (
    (context === 'tree-chat' && chatsRowLines === 'two') || (context === 'project' && projectRowLines === 'two')
      ? TIMELINE_SESSION_ESTIMATE
      : estimateSessionRow(context)
  );
  // The List view sorted by time replaces the project headers with one list
  // of every project's sessions, and Chats keep a section of their own there.
  const timeList = timelineMode && args.listGrouping === 'time';
  // Otherwise in the List view Chats can be one more group among the
  // projects, and without project groups everything is one combined list.
  const chatsAmongProjects = timelineMode && !timeList && timelineLayout.chats === 'group';
  const combinedTimeline = timelineMode && !timeList && !timelineLayout.projectGroups;
  const compactTimeline = timelineMode && timelineLayout.compactRows;

  /** Records the first header of a section, whichever row kind it is. */
  const markSectionStart = (key: SidebarSectionKey, rowIndex: number, dragId: string): void => {
    const row = rows[rowIndex];
    if (row && !sectionHeaders.some((header) => header.key === key)) {
      sectionHeaders.push(Object.freeze({ key, rowKey: row.key, dragId }));
    }
  };

  const appendChats = (sectionKey: SidebarSectionKey): void => {
    if (!args.chatGroup || (search && groupSearchMatches(args.chatGroup) === 0)) return;
    const rowIndex = rows.length;
    const collapsed = appendActivityHeader('chats');
    markSectionStart(sectionKey, rowIndex, sectionDragId('chats'));
    if (collapsed) return;
    // Chats sit on a short page that pinned chats do not spend. One line by
    // default in both views; two lines take the List's two-line row in List
    // and open the second line of the Tree row, which keeps its state slot.
    appendGroup(args.chatGroup, 'activity:chats', null, true, {
      initial: CHATS_INITIAL_LIMIT, increment: CHATS_INCREMENT, pinnedAlwaysVisible: true,
      renderContext: timelineMode ? (chatsRowLines === 'two' ? 'timeline' : 'timeline-chat') : 'tree-chat',
    });
  };

  // The zones list sessions of every project together: two-line rows with
  // the project's icon in List (one line with the icon first when List shows
  // one line per session), one-line rows in Tree unless the user asked for
  // two-line zone rows. Over the list by time they take its three-line rows, so
  // the zones and the list below share one row height.
  const zoneRenderContext: SessionSidebarRenderContext = timeList
    ? 'timeline-by-time'
    : timelineMode
      ? (compactTimeline ? 'mixed-flat' : 'timeline-mixed')
      : args.zoneRowLines === 'two' ? 'timeline-mixed' : 'mixed-compact';
  const countZoneMatches = (item: SessionSidebarActivityItem): number => (
    item.searchMatchCount ?? countSessionTreeQueryMatches(item.node, args.normalizedQuery)
  );

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
    countMatches?: (item: SessionSidebarActivityItem) => number,
  ): void => {
    const requested = Math.max(initialLimit, args.visibleCountByContainer.get(containerKey) ?? initialLimit);
    const entries = collapseActivityItems(items);
    const visibleEntries = search ? entries : entries.slice(0, requested);
    appendActivityItems(visibleEntries.flatMap((entry) => isActivityRunEntry(entry) ? entry.items : [entry]), containerKey, renderContext, countMatches);
    if (search) return;
    if (entries.length > visibleEntries.length) push({ kind: 'show-control', key: `${containerKey}:more`, estimateSize: STATUS_ESTIMATE, control: 'more', containerKey, currentCount: visibleEntries.length, increment, flat: true });
    else if (entries.length > initialLimit) push({ kind: 'show-control', key: `${containerKey}:fewer`, estimateSize: STATUS_ESTIMATE, control: 'fewer', containerKey, currentCount: visibleEntries.length, increment, flat: true });
  };

  // A zone lists a tree for its matching subsession too; the ancestors
  // around it are context, so only real matches count. Zones of sessions the
  // user does not follow can be long, so they open on a page of 7.
  const appendZone = (activityKey: Exclude<SidebarZoneKey, 'chats'>, items: readonly SessionSidebarActivityItem[]): void => {
    if (items.length === 0) return;
    const rowIndex = rows.length;
    const collapsed = appendActivityHeader(activityKey, isSidebarAttentionZoneKey(activityKey) ? items.length : undefined);
    markSectionStart(activityKey, rowIndex, sectionDragId(activityKey));
    if (collapsed) return;
    const containerKey = `activity:${activityKey}`;
    if (isOtherSessionsZone(activityKey)) {
      appendRevealedItems(items, containerKey, zoneRenderContext, SESSIONS_INITIAL_LIMIT, SESSIONS_INCREMENT, countZoneMatches);
    } else {
      appendActivityItems(items, containerKey, zoneRenderContext, countZoneMatches);
    }
  };

  // The List view sorted by time: one list of every project's root sessions
  // in lifecycle order, pinned first, under one zone header. It is
  // virtualized, so it reveals all of them at once. A session any zone lists
  // is left out here, so each session shows once.
  const appendTimeList = (): void => {
    const items = (args.timelineItems ?? []).filter((item) => item.projectId && !inZone.has(item.node.session.id));
    if (items.length > 0) {
      const rowIndex = rows.length;
      const collapsed = appendActivityHeader('timeline');
      markSectionStart('projects', rowIndex, sectionDragId('timeline'));
      if (!collapsed) appendActivityItems(items, 'activity:timeline', 'timeline-by-time');
    }
    // The list has no project headers to hold a load status, so it closes
    // with one line per distinct status of a project it lists nothing for,
    // as a project header would: one while any loads, and one per failure,
    // whose Retry reloads that directory or the global list.
    if (search || (items.length > 0 && args.collapsedActivities.has('timeline'))) return;
    const listedProjects = new Set((args.timelineItems ?? []).map((item) => item.projectId));
    const shown = new Set<string>();
    for (const section of args.sections) {
      if (listedProjects.has(section.project.id)) continue;
      // A project hidden from all sessions stays out of this list, its load status too.
      if (args.hiddenFromAllProjectIds?.has(section.project.id)) continue;
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
  };

  // A session the Pinned zone lists is left out of its project in List; the
  // other zones keep it in both places.
  const pinnedZoneIds = new Set((args.pinnedItems ?? []).map((item) => item.node.session.id));
  const isListedInTimeline = (item: SessionSidebarActivityItem): boolean => (
    !isMovedToZone(item.node.session.id) && !pinnedZoneIds.has(item.node.session.id)
  );

  // Without project groups: one header over every root session (and the
  // chats, when they join), in lifecycle order.
  const appendCombinedTimeline = (): void => {
    const items = (args.timelineItems ?? []).filter(isListedInTimeline);
    if (search && items.length === 0) return;
    const rowIndex = rows.length;
    const collapsed = appendActivityHeader('all');
    markSectionStart('projects', rowIndex, sectionDragId('all'));
    if (collapsed) return;
    appendRevealedItems(items, 'activity:all', zoneRenderContext, COMBINED_INITIAL_LIMIT, COMBINED_INCREMENT);
  };

  const appendTimelineProject = (section: ProjectSection, items: readonly SessionSidebarActivityItem[]): void => {
    const projectId = section.project.id;
    if (search && items.length === 0) return;
    const collapsed = !search && args.collapsedProjects.has(projectId);
    const rowIndex = rows.length;
    push({ kind: 'project-header', key: `project:${projectId}:header`, estimateSize: HEADER_ESTIMATE, section, collapsed, forceExpanded: search });
    stickyHeaders.push(Object.freeze({ rowIndex, kind: 'project', id: projectId }));
    markSectionStart('projects', rowIndex, projectId);
    if (collapsed) return;
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
      appendRevealedItems(items, timelineProjectContainerKey(projectId), compactTimeline ? 'timeline-chat' : 'timeline', SESSIONS_INITIAL_LIMIT, SESSIONS_INCREMENT);
      return;
    }
    const mainGroup = section.groups.find((group) => group.isMain);
    if (!mainGroup) return;
    const groupKey = `${projectId}:${mainGroup.id}`;
    const status = args.groupStatusByKey.get(groupKey);
    if (status && status.state !== 'ready') push({ kind: 'status', key: `${groupKey}:status`, estimateSize: STATUS_ESTIMATE, status, group: mainGroup, groupKey, flat: true });
  };

  // One header per project, in the user's manual order, over its root
  // sessions from every worktree in lifecycle order. Chats as a group take
  // their place among them, and then one heading, All sessions, covers the
  // projects and Chats together: it is the section's header to collapse and
  // to drag.
  const appendTimelineProjects = (): void => {
    const itemsByProject = new Map<string, SessionSidebarActivityItem[]>();
    for (const item of args.timelineItems ?? []) {
      if (!item.projectId || !isListedInTimeline(item)) continue;
      const list = itemsByProject.get(item.projectId);
      if (list) list.push(item);
      else itemsByProject.set(item.projectId, [item]);
    }
    if (chatsAmongProjects) {
      const chatsMatch = args.chatGroup !== null && groupSearchMatches(args.chatGroup) > 0;
      if (search && itemsByProject.size === 0 && !chatsMatch) return;
      const rowIndex = rows.length;
      const collapsed = appendActivityHeader('all');
      markSectionStart('projects', rowIndex, sectionDragId('all'));
      if (collapsed) return;
    }
    const chatsIndex = chatsAmongProjects ? Math.min(timelineLayout.chatsGroupIndex, args.sections.length) : -1;
    args.sections.forEach((section, index) => {
      if (index === chatsIndex) appendChats('projects');
      if (args.hiddenFromAllProjectIds?.has(section.project.id)) return;
      appendTimelineProject(section, itemsByProject.get(section.project.id) ?? []);
    });
    if (chatsIndex === args.sections.length) appendChats('projects');
  };

  const appendTreeProjects = (): void => {
    let projectSections = args.singleProjectMode
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
        markSectionStart('projects', rowIndex, section.project.id);
      }
      if (projectCollapsed) continue;
      // A project hidden from all sessions keeps its header, the way back
      // to the project, but contributes no group or session rows, as in
      // the List view. A single project opened on its own, or the main
      // workspace shown alone, is an explicit focus and still lists rows.
      if (!args.singleProjectMode && !args.showOnlyMainWorkspace && args.hiddenFromAllProjectIds?.has(section.project.id)) continue;
      for (const descriptor of descriptors) appendGroup(descriptor.group, descriptor.groupKey, descriptor.projectId, descriptor.hideGroupLabel);
    }
  };

  for (const key of args.sectionOrder ?? CLASSIC_SIDEBAR_LAYOUT.sectionOrder) {
    if (key === 'chats') {
      // Chats joining the projects are drawn with them.
      if (!chatsAmongProjects) appendChats('chats');
    } else if (key === 'pinned') {
      appendZone('pinned', args.pinnedItems ?? []);
    } else if (key === 'work') {
      appendZone('work', args.workItems ?? []);
    } else if (key === 'projects') {
      if (timeList) appendTimeList();
      else if (combinedTimeline) appendCombinedTimeline();
      else if (timelineMode) appendTimelineProjects();
      else appendTreeProjects();
    } else {
      appendZone(key, args.attentionItems?.get(key) ?? []);
    }
  }

  // A search whose only matches sit in projects hidden from all
  // sessions leaves just their headers behind; that is still no
  // visible result, so the search-empty row shows alongside them.
  const onlyHiddenProjectHeaders =
    search &&
    searchMatchCount === 0 &&
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.kind === 'project-header' &&
        args.hiddenFromAllProjectIds?.has(row.section.project.id),
    );
  if (rows.length === 0 || onlyHiddenProjectHeaders) {
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
    sectionHeaders: Object.freeze(sectionHeaders),
    navigationEntries: Object.freeze(navigationEntries),
    folderDropTargets: Object.freeze(folderDropTargets),
    folderAuthorityByOwner: args.folderAuthorityByOwner,
    sessionById,
    searchMatchCount: search ? searchMatchCount : 0,
  });
};
