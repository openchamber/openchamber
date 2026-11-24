import type { Session } from '@/lib/opencode/model';
import { listedChildren, listedRoots } from './listedChildren';
import type { SessionFolder, SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import { compareSessionsByLifecycleOrder, EMPTY_SESSION_ORDER_RANKS } from '@/sync/session-ordering';
import { isSessionPinned } from '@/lib/sessionPins';
import type { SessionGroup, SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildGroupRenderDescriptors } from './projects/sessionProjectRender';
import { normalizeFolderRoots, selectFolderIdsForProjection, selectFolderRootNodes, type BlockingBadgeSessionScope } from './sessions/sessionNodeItemUtils';
import { getAuthoritativeSessionFolderOwnerKey, getGroupFolderOwnerKey, getSessionFolderIdentityKey, getSessionFolderScopes, isArchivedFolderScope, resolveSessionFolderOwnerKey } from './sessions/sessionFolderIdentity';
import type { SessionRowOrderEntry, SessionRowOrderWork } from './sessions/sessionRowOrder';
import { computeSessionTreeGuides, type SessionTreeGuide } from './sessions/sessionTreeGeometry';
import { EMPTY_MULTI_RUN_INDEX, type MultiRunIndex, type MultiRunSummary } from '@/lib/multirun/runs';
import { isGroupWork, worktreeFolderMemberId } from './works/sidebarWorks';
import type { SessionDraft } from '@/stores/useSessionDraftsStore';
import type { DirectoryOwner } from './sessions/sessionOwnership';
import type { ConversationResult } from '@/hooks/useConversationSearch';
import { conversationContextFromLocation, type ConversationResultContext, type ConversationResultProject } from '@/components/search/conversationResultContext';
import type { SidebarSessionLocation } from './recent/sessionLocation';
import { SIDEBAR_SESSION_BATCH_DEFAULT } from '@/lib/sidebarSections';

export type SessionSidebarActivityItem = {
  node: SessionNode;
  blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null; inSpace?: boolean } | null;
  getSecondaryMeta?: (sessionId: string) => SessionSidebarActivityItem['secondaryMeta'];
};

export type SessionSidebarWorkEntry =
  | { kind: 'session'; item: SessionSidebarActivityItem }
  | { kind: 'group'; groupKey: string; projectId: string; group: SessionGroup }
  | { kind: 'draft'; draft: SessionDraft; projectId: string };

export type SessionSidebarActivityKey = 'pages' | 'pinned' | 'work' | 'chats' | 'timeline' | `section:${string}`;

export const sidebarSectionActivityKey = (id: string): `section:${string}` => `section:${id}`;

export type SessionSidebarBlock =
  | { kind: 'pages'; pages: readonly { id: string; open: boolean }[] }
  | { kind: 'chats' }
  | { kind: 'pinned' }
  | { kind: 'work' }
  | { kind: 'custom'; id: string; name: string; entries: readonly SessionSidebarWorkEntry[]; hideWhenEmpty: boolean; preview: boolean }
  | { kind: 'project-group'; id: string; name: string; projectIds: readonly string[]; hideWhenEmpty: boolean; preview: boolean }
  | { kind: 'projects'; excludedProjectIds?: ReadonlySet<string> };

const DEFAULT_BLOCKS: readonly SessionSidebarBlock[] = [{ kind: 'chats' }, { kind: 'pinned' }, { kind: 'work' }, { kind: 'projects' }];

export const SIDEBAR_ACTIVITY_KEYS: readonly SessionSidebarActivityKey[] = ['pages', 'chats', 'pinned', 'work', 'timeline'];
const PINNED_ZONE_KEY = 'activity:pinned';
export const isPinnedZoneRowKey = (rowKey: string): boolean => rowKey.startsWith(`${PINNED_ZONE_KEY}:`);
export const PROJECTS_CAPTION_COLLAPSE_KEY = 'projects';

export type SessionSidebarRenderContext = 'project' | 'timeline-mixed' | 'mixed-compact' | 'tree-chat';

export const isMultiLineTimelineContext = (context: SessionSidebarRenderContext): boolean => context === 'timeline-mixed';

export type SessionSidebarGroupStatus = {
  state: 'ready' | 'loading' | 'load-failed' | 'initialization-failed' | 'permission-denied' | 'trust-paused';
  directory: string | null;
  canGrantAccess: boolean;
};

export type SessionSidebarOwnerAuthority = {
  scopeKeys: readonly string[];
  complete: boolean;
};

type RowBase = { key: string; estimateSize: number; treeGuides?: readonly SessionTreeGuide[] };

export type SessionSidebarRow =
  | (RowBase & { kind: 'activity-header'; activityKey: SessionSidebarActivityKey; collapsed: boolean; label?: string; preview?: boolean; loading?: boolean })
  | (RowBase & { kind: 'project-header'; section: ProjectSection; collapsed: boolean })
  | (RowBase & { kind: 'caption'; caption: 'projects' | `section:${string}`; collapsed: boolean; label?: string; preview?: boolean })
  | (RowBase & { kind: 'group-header'; group: SessionGroup; groupKey: string; projectId: string | null; collapsed: boolean; empty: boolean; allSessions: readonly Session[]; depth: number; mixed: boolean; detailed: boolean })
  | (RowBase & { kind: 'folder-header'; depth: number; group: SessionGroup; folder: SessionFolder; displayName: string; scopeKey: string; scopeDirectory: string | null; ownerKey: string | null; nodes: readonly SessionNode[]; activityNodes: readonly SessionNode[]; projectId: string | null; archived: boolean; collapsed: boolean; empty: boolean; deleteSessions: readonly Session[]; subFolderCount: number; memberCount: number; dropEnabled: boolean; mixed: boolean })
  | (RowBase & { kind: 'session'; node: SessionNode; blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[]; depth: number; ownsWork: boolean; projectId: string | null; ownerProjectId: string | null; groupDirectory: string | null; ownerKey: string | null; selectionScopeKey: string | null; archived: boolean; renderContext: SessionSidebarRenderContext; secondaryMeta: SessionSidebarActivityItem['secondaryMeta']; detailed?: boolean; expanded?: boolean; repeat?: boolean })
  | (RowBase & { kind: 'draft'; draft: SessionDraft; depth: number; projectId: string | null; mixed: boolean; detailed: boolean })
  | (RowBase & { kind: 'run'; run: MultiRunSummary; depth: number; laneNodes: readonly SessionNode[]; blockingSessionIds: readonly string[]; projectId: string | null; projectLabel: string | null; groupDirectory: string | null; renderContext: SessionSidebarRenderContext; expansionKey: string; expanded: boolean; detailed: boolean })
  | (RowBase & { kind: 'empty'; emptyKind: 'sidebar' | 'search' | 'archived' | 'section'; depth?: number })
  | (RowBase & { kind: 'status'; status: SessionSidebarGroupStatus; group: SessionGroup; groupKey: string; depth?: number; flat?: boolean; detailed?: boolean })
  | (RowBase & { kind: 'show-control'; more: boolean; fewer: boolean; hiddenNodes: SessionNode[]; containerKey: string; currentCount: number; requestedCount: number; increment: number; depth?: number; flat?: boolean; detailed?: boolean })
  | (RowBase & { kind: 'page'; pageId: string; open: boolean })
  | (RowBase & { kind: 'search-result'; result: ConversationResult; context: ConversationResultContext })
  | (RowBase & { kind: 'search-archived-caption' })
  | (RowBase & { kind: 'search-show-more'; section: SearchResultSection; hidden: number })
  | (RowBase & { kind: 'search-more'; section: SearchResultSection });

export type SessionSidebarStickyHeader = {
  rowIndex: number;
  kind: 'activity' | 'project' | 'search';
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
  folderOwnerKeyBySessionId: ReadonlyMap<string, string>;
  selectionWorks: readonly SessionRowOrderWork[];
  search: boolean;
  searchMatchCount: number;
};

export type SessionSidebarRowModelArgs = {
  mode: 'normal' | 'search';
  sections: readonly ProjectSection[];
  authoritativeSections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  archivedChatGroup?: SessionGroup | null;
  pinnedItems?: readonly SessionSidebarActivityItem[];
  pinnedWorktrees?: readonly SessionSidebarWorkEntry[];
  workEntries?: readonly SessionSidebarWorkEntry[];
  timeEntries?: readonly SessionSidebarWorkEntry[] | null;
  draftsByGroupKey?: ReadonlyMap<string, readonly SessionDraft[]>;
  movedSessionIds?: ReadonlySet<string>;
  movedGroupKeys?: ReadonlySet<string>;
  detailedZoneRows?: boolean; showSubagentSessions?: boolean;
  foldersMap: SessionFoldersMap;
  contentSearchResults?: readonly ConversationResult[];
  revealedSearchSections?: ReadonlySet<SearchResultSection>;
  searchSectionsWithMore?: ReadonlySet<SearchResultSection>;
  searchIncomplete?: boolean;
  collapsedProjects: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  collapsedFolders: ReadonlySet<string>;
  collapsedActivities: ReadonlySet<string>;
  expandedParents: ReadonlySet<string>;
  visibleCountByContainer: ReadonlyMap<string, number>;
  pinnedSessionIds: ReadonlySet<string>;
  sessionOrderIndex: ReadonlyMap<string, number>;
  worktreeArchiveAnchors?: ReadonlyMap<string, number>;
  liveSpaceIds?: ReadonlySet<string>;
  groupStatusByKey: ReadonlyMap<string, SessionSidebarGroupStatus>;
  folderAuthorityByOwner: ReadonlyMap<string, SessionSidebarOwnerAuthority>;
  sessionOwnerById: ReadonlyMap<string, DirectoryOwner>;
  searchLocationById?: ReadonlyMap<string, SidebarSessionLocation>;
  searchProjectById?: ReadonlyMap<string, ConversationResultProject>;
  homeDirectory?: string | null;
  activeProjectId: string | null;
  singleProjectMode: boolean;
  singleProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hideDirectoryControls: boolean;
  projectsCaption?: boolean;
  projectsCaptionAtTop?: boolean;
  sessionBatchSize?: number;
  runIndex?: MultiRunIndex;
  blocks?: readonly SessionSidebarBlock[];
};

type RunEntry = { run: MultiRunSummary; lanes: SessionNode[] };
type SidebarEntry = SessionNode | RunEntry;

const isRunEntry = (entry: SidebarEntry): entry is RunEntry => 'run' in entry;

export const sessionExpansionKey = (renderContext: SessionSidebarRenderContext, archived: boolean, sessionId: string): string => (
  `${renderContext}:${archived ? 'archived' : 'active'}:${sessionId}`
);

export const runExpansionKey = (renderContext: SessionSidebarRenderContext, runKey: string): string => (
  `${renderContext}:active:run:${runKey}`
);

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

const EMPTY_FOLDERS: readonly SessionFolder[] = [];
const EMPTY_ZONE_SESSION_IDS: ReadonlySet<string> = new Set();
const EMPTY_DRAFTS: readonly SessionDraft[] = [];
const EMPTY_ARCHIVE_ANCHORS: ReadonlyMap<string, number> = new Map();
const EMPTY_SPACE_IDS: ReadonlySet<string> = new Set();
const SESSION_ESTIMATE = 32;
const TIMELINE_SESSION_ESTIMATE = 52;
const estimateSessionRow = (context: SessionSidebarRenderContext): number => (
  isMultiLineTimelineContext(context) ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE
);
const CHATS_INITIAL_LIMIT = 3;
const CHATS_INCREMENT = 7;
const EMPTY_WORK_ENTRIES: readonly SessionSidebarWorkEntry[] = Object.freeze([]);
const SESSIONS_INITIAL_LIMIT = SIDEBAR_SESSION_BATCH_DEFAULT;
const SESSIONS_INCREMENT = SIDEBAR_SESSION_BATCH_DEFAULT;

const SEARCH_ROW_ESTIMATE = 32;
const SEARCH_EXCERPT_ESTIMATE = 20;
const searchRowEstimate = (hasExcerpt: boolean): number => SEARCH_ROW_ESTIMATE + (hasExcerpt ? SEARCH_EXCERPT_ESTIMATE : 0);
export const ACTIVE_SEARCH_INITIAL = 50;
export type SearchResultSection = 'active' | 'archived';

const HEADER_ESTIMATE = 32;
const SECTION_HEADER_ESTIMATE = 34;
const STATUS_ESTIMATE = 28;

const treeLevelOf = (row: SessionSidebarRow): number | null => {
  switch (row.kind) {
    case 'group-header': return row.depth;
    case 'folder-header': return row.depth;
    case 'draft': return row.depth;
    case 'session':
    case 'run': return row.depth;
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

const mergeWorktreeEntries = (
  entries: readonly SidebarEntry[],
  worktrees: readonly WorktreeInFolder[],
  sessionOrderIndex: ReadonlyMap<string, number>,
  archiveAnchors: ReadonlyMap<string, number>,
  liveSpaceIds: ReadonlySet<string>,
): ListedEntry[] => {
  if (worktrees.length === 0) return [...entries];
  const rankOfNode = (node: SessionNode): number => sessionOrderIndex.get(node.session.id) ?? Number.POSITIVE_INFINITY;
  const rankOfEntry = (entry: SidebarEntry): number => (isRunEntry(entry) ? Math.min(...entry.lanes.map(rankOfNode)) : rankOfNode(entry));
  const rankOfWorktree = ({ group, groupKey }: WorktreeInFolder): number => {
    if (group.worktree?.pinnedAt !== undefined) return Number.NEGATIVE_INFINITY;
    if (group.space && liveSpaceIds.has(group.space.id) && group.sessions.length === 0 && !archiveAnchors.has(groupKey)) return Number.NEGATIVE_INFINITY;
    let best = archiveAnchors.get(groupKey) ?? Number.POSITIVE_INFINITY;
    const stack = [...group.sessions];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      best = Math.min(best, rankOfNode(node));
      stack.push(...node.children);
    }
    return best;
  };
  const ranked = worktrees
    .map((worktree) => ({ worktree, rank: rankOfWorktree(worktree) }))
    .sort((left, right) => left.rank - right.rank);
  const merged: ListedEntry[] = [];
  let next = 0;
  for (const entry of entries) {
    const rank = rankOfEntry(entry);
    while (next < ranked.length && (ranked[next]?.rank ?? 0) < rank) {
      const item = ranked[next];
      if (item) merged.push({ listedWorktree: item.worktree });
      next += 1;
    }
    merged.push(entry);
  }
  for (; next < ranked.length; next += 1) {
    const item = ranked[next];
    if (item) merged.push({ listedWorktree: item.worktree });
  }
  return merged;
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

type WorktreeInFolder = { group: SessionGroup; groupKey: string };
type WorktreeEntry = { listedWorktree: WorktreeInFolder };
type ListedEntry = SidebarEntry | WorktreeEntry;
const isWorktreeEntry = (entry: ListedEntry): entry is WorktreeEntry => 'listedWorktree' in entry;

type GroupPlacement = { keyPrefix: string; depth: number; mixed: boolean; foldersOnly?: boolean; zoneScopeKey?: string };
const PROJECT_PLACEMENT: GroupPlacement = { keyPrefix: '', depth: 0, mixed: false };

export const buildSessionSidebarRowModel = (args: SessionSidebarRowModelArgs): SessionSidebarRowModel => {
  const rows: SessionSidebarRow[] = [];
  const shownSessionIds = new Set<string>();
  const selectionEntries: SessionRowOrderEntry[] = [];
  const selectionDescendantIds: string[] = [];
  const selectionWorks = new Map<string, SessionRowOrderWork>();
  const stickyHeaders: SessionSidebarStickyHeader[] = [];
  const folderDropTargets: SessionSidebarFolderTarget[] = [];
  const sessionById = new Map<string, Session>();
  const folderOwnerKeyBySessionId = new Map<string, string>();
  const keyOccurrences = new Map<string, number>();
  const search = args.mode === 'search';
  const pinned = args.pinnedSessionIds instanceof Set ? args.pinnedSessionIds : new Set(args.pinnedSessionIds);
  const movedSessionIds = args.movedSessionIds ?? EMPTY_ZONE_SESSION_IDS;
  const movedGroupKeys = args.movedGroupKeys ?? EMPTY_ZONE_SESSION_IDS;
  const isMovedToZone = (sessionId: string): boolean => movedSessionIds.has(sessionId);
  const movedFolderMembers = new Set<string>();
  const runIndex = args.runIndex ?? EMPTY_MULTI_RUN_INDEX;
  const folderOwnerKeyOf = (session: Session): string | null => resolveSessionFolderOwnerKey(
    session,
    args.sessionOwnerById.get(session.id),
    runIndex.runKeyBySessionId.has(session.id),
  );

  const authoritativeRoots = [
    ...args.authoritativeSections.flatMap((section) => section.groups.flatMap((group) => group.sessions)),
    ...(args.chatGroup?.sessions ?? []),
    ...(args.archivedChatGroup?.sessions ?? []),
  ];
  const authorityStack = [...authoritativeRoots];
  while (authorityStack.length > 0) {
    const node = authorityStack.pop();
    if (!node) continue;
    sessionById.set(node.session.id, node.session);
    const folderOwnerKey = folderOwnerKeyOf(node.session);
    if (folderOwnerKey) folderOwnerKeyBySessionId.set(node.session.id, folderOwnerKey);
    authorityStack.push(...node.children);
  }

  const keyFor = (base: string): string => {
    const occurrence = keyOccurrences.get(base) ?? 0;
    keyOccurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:${occurrence}`;
  };
  const push = (row: SessionSidebarRow): void => {
    if (row.kind === 'session') {
      const repeat = shownSessionIds.has(row.node.session.id);
      shownSessionIds.add(row.node.session.id);
      if (repeat) {
        rows.push(Object.freeze({ ...row, repeat: true }));
        return;
      }
    }
    rows.push(Object.freeze(row));
  };
  const appendFoldedSelection = (
    nodes: readonly SessionNode[],
    indexed: IndexedSessionNodes,
    selectionPoolOffset: number,
    scopeKey: string,
    archived: boolean,
  ): void => {
    for (const node of nodes) {
      const range = indexed.subtreeRangeByNode.get(node);
      selectionEntries.push(Object.freeze({
        id: node.session.id,
        rowKey: null,
        scopeKey,
        archived,
        descendantRange: range && range[1] > range[0] + 1
          ? Object.freeze([selectionPoolOffset + range[0] + 1, selectionPoolOffset + range[1]] as const)
          : undefined,
      }));
    }
  };
  const projectRootById = new Map(args.authoritativeSections.map((section) => [section.project.id, section.project.normalizedPath]));
  const searchContext = (result: ConversationResult): ConversationResultContext => {
    const location = args.searchLocationById?.get(result.sessionId);
    const projectId = location?.projectId ?? null;
    return conversationContextFromLocation({
      location,
      directory: result.directory,
      project: projectId ? args.searchProjectById?.get(projectId) ?? null : null,
      projectRoot: projectId ? projectRootById.get(projectId) ?? null : null,
      homeDirectory: args.homeDirectory ?? null,
    });
  };
  type AppendOptions = {
    nodes: readonly SessionNode[];
    blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
    containerKey: string;
    projectId: string | null;
    groupDirectory: string | null;
    selectionScopeKey: string | null;
    zoneScopeKey?: string;
    archived: boolean;
    renderContext: SessionSidebarRenderContext;
    secondaryMeta?: SessionSidebarActivityItem['secondaryMeta'];
    getSecondaryMeta?: SessionSidebarActivityItem['getSecondaryMeta'];
    getBlockingBadgeSessionScopes?: (sessionId: string) => readonly BlockingBadgeSessionScope[] | undefined;
    indexedNodes?: IndexedSessionNodes;
    selectionPoolOffset?: number;
    detailedRoots?: boolean;
    baseDepth?: number;
    insideWork?: boolean;
  };
  const appendRun = (entry: RunEntry, options: AppendOptions): void => {
    const expansionKey = runExpansionKey(options.renderContext, entry.run.key);
    const expanded = args.expandedParents.has(expansionKey);
    const detailed = options.renderContext === 'timeline-mixed' || options.detailedRoots === true;
    const firstLaneId = entry.lanes[0]?.session.id;
    const meta = firstLaneId && options.getSecondaryMeta ? options.getSecondaryMeta(firstLaneId) : options.secondaryMeta;
    const blockingSessionIds = Object.freeze([...new Set(entry.lanes.flatMap((lane) => (
      options.getBlockingBadgeSessionScopes?.(lane.session.id) ?? []
    ).flatMap((scope) => scope.sessionIDs)))]);
    push({
      kind: 'run',
      key: keyFor(`${options.containerKey}:run:${entry.run.key}`),
      estimateSize: detailed ? TIMELINE_SESSION_ESTIMATE : estimateSessionRow(options.renderContext),
      detailed,
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
    });
    if (!expanded) {
      if (options.zoneScopeKey && options.indexedNodes) {
        appendFoldedSelection(entry.lanes, options.indexedNodes, options.selectionPoolOffset ?? 0, options.zoneScopeKey, options.archived);
      }
      return;
    }
    appendTrees(entry.lanes, (options.baseDepth ?? 0) + 1, {
      ...options,
      detailedRoots: false,
      insideWork: true,
      renderContext: options.renderContext === 'timeline-mixed' ? 'mixed-compact' : options.renderContext,
    });
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
      const detailed = options.detailedRoots === true && current.depth === baseDepth;
      const rowContext: SessionSidebarRenderContext = current.depth > baseDepth && options.renderContext === 'timeline-mixed'
        ? 'mixed-compact'
        : options.renderContext;
      const sessionOwner = args.sessionOwnerById.get(current.node.session.id);
      const ownerKey = folderOwnerKeyOf(current.node.session)
        ?? folderOwnerKeyBySessionId.get(current.node.session.id)
        ?? null;
      const selectionScopeKey = options.zoneScopeKey ?? (options.selectionScopeKey === null
        ? null
        : getAuthoritativeSessionFolderOwnerKey(current.node.session, sessionOwner) ?? ownerKey);
      const expanded = args.expandedParents.has(expandedKey(rowContext, options.archived, current.node.session.id));
      const children = listedChildren(current.node, args.showSubagentSessions ?? true);
      push({
        kind: 'session',
        key: rowKey,
        estimateSize: detailed ? TIMELINE_SESSION_ESTIMATE : estimateSessionRow(rowContext),
        expanded: children.length > 0 ? expanded : undefined,
        detailed,
        node: current.node,
        blockingBadgeSessionScopes: current.depth === baseDepth
          ? options.getBlockingBadgeSessionScopes?.(current.node.session.id) ?? options.blockingBadgeSessionScopes
          : undefined,
        depth: current.depth,
        ownsWork: options.insideWork !== true && current.depth === baseDepth,
        projectId: options.projectId,
        ownerProjectId: sessionOwner?.projectId ?? null,
        groupDirectory: current.directory,
        ownerKey,
        selectionScopeKey,
        archived: options.archived,
        renderContext: rowContext,
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
        scopeKey: selectionScopeKey,
        archived: options.archived,
        descendantRange,
      }));
      if (!expanded) continue;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) stack.push({ node: child, depth: current.depth + 1, directory });
      }
    }
  };

  const appendGroup = (
    group: SessionGroup,
    groupKey: string,
    projectId: string | null,
    hideHeader: boolean,
    limits?: { initial?: number; increment?: number; pinnedAlwaysVisible?: boolean; renderContext: SessionSidebarRenderContext; loadingInHeader?: boolean },
    placement: GroupPlacement = PROJECT_PLACEMENT,
    worktreesByMemberId?: ReadonlyMap<string, WorktreeInFolder>,
    listedWorktrees: readonly WorktreeInFolder[] = [],
  ): void => {
    const rowKeyBase = `${placement.keyPrefix}${groupKey}`;
    const sourceNodes = group.sessions
      .filter((node) => !isMovedToZone(node.session.id))
      .sort((left, right) => compareNodes(left, right, pinned, args.sessionOrderIndex));
    const indexed = indexNodes(sourceNodes);
    const selectionPoolOffset = selectionDescendantIds.length;
    selectionDescendantIds.push(...indexed.preorderIds);
    for (const [id, session] of indexed.sessionsById) sessionById.set(id, session);
    if (projectId && isGroupWork(group) && !selectionWorks.has(groupKey)) selectionWorks.set(groupKey, Object.freeze({ group, projectId }));
    const ownerKey = getGroupFolderOwnerKey(projectId, group);
    const storedCollapsed = args.collapsedGroups.has(groupKey);
    const contentDepth = hideHeader ? 0 : placement.depth + 1;
    const status = args.groupStatusByKey.get(groupKey);
    const groupLoaded = !status || status.state === 'ready';
    const groupDrafts = args.draftsByGroupKey?.get(groupKey) ?? EMPTY_DRAFTS;
    const detailedWorks = args.detailedZoneRows === true && group.isMain === true && limits?.renderContext !== 'tree-chat';
    const detailedMeta = detailedWorks && group.branch ? { branchLabel: group.branch } : undefined;
    const insideWork = isGroupWork(group);
    const empty = sourceNodes.length === 0
      && groupDrafts.length === 0
      && groupLoaded
      && getSessionFolderScopes(group).every(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).length === 0);
    const appendDrafts = (): void => {
      for (const draft of groupDrafts) {
        push({ kind: 'draft', key: keyFor(`${rowKeyBase}:draft:${draft.id}`), estimateSize: detailedWorks ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE, draft, depth: contentDepth, projectId, mixed: false, detailed: detailedWorks });
      }
    };
    if (!hideHeader) {
      const allSessions = indexed.preorderIds.flatMap((id) => indexed.sessionsById.get(id) ?? []);
      const detailed = args.detailedZoneRows === true && isGroupWork(group);
      const estimateSize = detailed ? TIMELINE_SESSION_ESTIMATE : isGroupWork(group) ? SESSION_ESTIMATE : HEADER_ESTIMATE;
      push({ kind: 'group-header', key: `${rowKeyBase}:header`, estimateSize, group, groupKey, projectId, collapsed: storedCollapsed && !empty, empty, allSessions: Object.freeze(allSessions), depth: placement.depth, mixed: placement.mixed, detailed });
    }
    if (storedCollapsed && !empty) {
      if (placement.zoneScopeKey) appendFoldedSelection(sourceNodes, indexed, selectionPoolOffset, placement.zoneScopeKey, group.isArchivedBucket === true);
      return;
    }

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
    })), { archivedBucket: group.isArchivedBucket === true, searchQuery: '' });
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
      const folderWorktrees = worktreesByMemberId
        ? entry.folder.sessionIds.flatMap((memberId) => worktreesByMemberId.get(memberId) ?? [])
        : [];
      const folderEmpty = groupLoaded && entry.nodes.length === 0 && folderWorktrees.length === 0 && (childFolders.get(identity)?.length ?? 0) === 0;
      const folderCollapsed = !folderEmpty && args.collapsedFolders.has(entry.folder.id);
      const deleteSessions = folderSessionsByIdentity.get(identity) ?? [];
      const movedMembers = entry.folder.sessionIds.filter((memberId) => isMovedToZone(memberId) || movedFolderMembers.has(memberId)).length;
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
        collapsed: folderCollapsed, empty: folderEmpty,
        deleteSessions,
        subFolderCount: childFolders.get(identity)?.length ?? 0,
        memberCount: entry.nodes.length + folderWorktrees.length + movedMembers, dropEnabled, mixed: placement.mixed,
      });
      if (ownerKey) folderDropTargets.push(Object.freeze({ rowKey: folderKey, scopeKey: entry.scopeKey, folderId: entry.folder.id, ownerKey, enabled: dropEnabled }));
      if (folderCollapsed) {
        if (placement.zoneScopeKey) {
          const folded = selectFolderRootNodes([...new Set(deleteSessions.map((session) => session.id))], indexed.byId);
          appendFoldedSelection(folded, indexed, selectionPoolOffset, placement.zoneScopeKey, group.isArchivedBucket === true);
        }
        return;
      }
      appendSessions({ nodes: listedRoots(entry.nodes, args.showSubagentSessions ?? true), containerKey: folderKey, projectId, groupDirectory: entry.scopeDirectory ?? group.directory, selectionScopeKey: ownerKey, zoneScopeKey: placement.zoneScopeKey, archived: group.isArchivedBucket === true, renderContext: 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth + 1, detailedRoots: detailedWorks, secondaryMeta: detailedMeta, insideWork });
      for (const worktree of folderWorktrees) {
        appendGroup(worktree.group, worktree.groupKey, projectId, false, undefined, {
          keyPrefix: '', depth: contentDepth + 1, mixed: false, zoneScopeKey: placement.zoneScopeKey,
        });
      }
      for (const child of childFolders.get(identity) ?? []) appendFolder(child, displayName);
    };
    for (const folder of roots) appendFolder(folder, '');
    if (placement.foldersOnly) return;

    const sessionBatchSize = projectId ? args.sessionBatchSize : undefined;
    const initialLimit = limits?.initial ?? sessionBatchSize ?? (args.hideDirectoryControls ? 10 : SESSIONS_INITIAL_LIMIT);
    const increment = limits?.increment ?? sessionBatchSize ?? SESSIONS_INCREMENT;
    const requested = Math.max(initialLimit, args.visibleCountByContainer.get(groupKey) ?? initialLimit);
    const isPinnedNode = (entry: ListedEntry): boolean => !isWorktreeEntry(entry) && !isRunEntry(entry) && limits?.pinnedAlwaysVisible === true
      && isSessionPinned(pinned, entry.session.directory ?? group.directory, entry.session.id);
    const ungroupedEntries = mergeWorktreeEntries(collapseRunEntries(ungrouped, runIndex, group.isArchivedBucket === true), listedWorktrees, args.sessionOrderIndex, args.worktreeArchiveAnchors ?? EMPTY_ARCHIVE_ANCHORS, args.liveSpaceIds ?? EMPTY_SPACE_IDS);
    const limitedNodes = ungroupedEntries.filter((entry) => !isPinnedNode(entry));
    let budget = requested;
    const visibleEntries = group.isArchivedBucket
      ? ungroupedEntries
      : ungroupedEntries.filter((entry) => {
        if (isPinnedNode(entry)) return true;
        if (budget <= 0) return false;
        budget -= 1;
        return true;
      });
    if (group.isMain) appendDrafts();
    let pendingNodes: SessionNode[] = [];
    const flushSessions = (): void => {
      if (pendingNodes.length === 0) return;
      appendSessions({ nodes: pendingNodes, containerKey: rowKeyBase, projectId, groupDirectory: group.directory, selectionScopeKey: ownerKey, zoneScopeKey: placement.zoneScopeKey, archived: group.isArchivedBucket === true, renderContext: limits?.renderContext ?? 'project', indexedNodes: indexed, selectionPoolOffset, baseDepth: contentDepth, detailedRoots: detailedWorks, secondaryMeta: detailedMeta, insideWork });
      pendingNodes = [];
    };
    for (const entry of visibleEntries) {
      if (!isWorktreeEntry(entry)) {
        pendingNodes.push(...(isRunEntry(entry) ? entry.lanes : [entry]));
        continue;
      }
      flushSessions();
      appendGroup(entry.listedWorktree.group, entry.listedWorktree.groupKey, projectId, false, undefined, {
        keyPrefix: placement.keyPrefix, depth: contentDepth, mixed: placement.mixed, zoneScopeKey: placement.zoneScopeKey,
      });
    }
    flushSessions();
    if (!group.isMain) appendDrafts();
    const remaining = ungroupedEntries.length - visibleEntries.length;
    const limitedVisibleCount = requested - budget;
    const more = remaining > 0;
    if (more && placement.zoneScopeKey) {
      const visibleSet = new Set(visibleEntries);
      const hidden = ungroupedEntries.flatMap((entry) => (
        visibleSet.has(entry) || isWorktreeEntry(entry) ? [] : isRunEntry(entry) ? entry.lanes : [entry]
      ));
      appendFoldedSelection(hidden, indexed, selectionPoolOffset, placement.zoneScopeKey, group.isArchivedBucket === true);
    }
    const fewer = requested > initialLimit && limitedNodes.length > initialLimit;
    if (!group.isArchivedBucket && (more || fewer)) {
      const visibleSet = new Set(visibleEntries);
      const hiddenNodes = ungroupedEntries.filter((entry) => !visibleSet.has(entry)).flatMap((entry) => (
        isWorktreeEntry(entry)
          ? entry.listedWorktree.group.sessions.filter((node) => !isMovedToZone(node.session.id))
          : isRunEntry(entry) ? entry.lanes : [entry]
      ));
      push({ kind: 'show-control', key: `${rowKeyBase}:show`, estimateSize: STATUS_ESTIMATE, more, fewer, hiddenNodes, containerKey: groupKey, currentCount: limitedVisibleCount, requestedCount: requested, increment, depth: contentDepth, flat: false, detailed: detailedWorks });
    }

    if (sourceNodes.length === 0 && visibleFolders.length === 0) {
      if (status && status.state !== 'ready' && !(limits?.loadingInHeader && status.state === 'loading')) push({ kind: 'status', key: `${rowKeyBase}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth, detailed: detailedWorks });
      else if (group.isArchivedBucket) push({ kind: 'empty', key: `${rowKeyBase}:empty`, estimateSize: STATUS_ESTIMATE, emptyKind: 'archived', depth: contentDepth });
    } else if (status && status.state !== 'ready' && status.state !== 'loading') {
      push({ kind: 'status', key: `${rowKeyBase}:status`, estimateSize: STATUS_ESTIMATE, status, group, groupKey, depth: contentDepth, detailed: detailedWorks });
    }
  };

  const appendActivityHeader = (activityKey: SessionSidebarActivityKey, named?: { label: string; preview: boolean }, loading?: boolean): boolean => {
    const collapsed = args.collapsedActivities.has(activityKey);
    const rowIndex = rows.length;
    push({ kind: 'activity-header', key: `activity:${activityKey}:header`, estimateSize: SECTION_HEADER_ESTIMATE, activityKey, collapsed, loading, ...named });
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
    zoneScopeKey: string | undefined,
  ): void => {
    const first = entry.items[0];
    if (!first) return;
    const lanes = entry.items.map((item) => item.node);
    const indexed = indexNodes(lanes);
    const selectionPoolOffset = selectionDescendantIds.length;
    selectionDescendantIds.push(...indexed.preorderIds);
    const metaById = new Map(entry.items.map((item) => [
      item.node.session.id,
      item.getSecondaryMeta ? item.getSecondaryMeta(item.node.session.id) : item.secondaryMeta,
    ]));
    const badgeScopesById = new Map(entry.items.map((item) => [item.node.session.id, item.blockingBadgeSessionScopes]));
    appendRun({ run: entry.run, lanes }, {
      nodes: lanes, containerKey, projectId: first.projectId, groupDirectory: first.groupDirectory,
      selectionScopeKey: null, zoneScopeKey, archived: false, renderContext,
      getSecondaryMeta: (sessionId) => metaById.get(sessionId) ?? null,
      getBlockingBadgeSessionScopes: (sessionId) => badgeScopesById.get(sessionId),
      indexedNodes: indexed, selectionPoolOffset,
    });
  };

  const appendActivityItems = (
    items: readonly SessionSidebarActivityItem[],
    containerKey: string,
    renderContext: SessionSidebarRenderContext,
    zoneScopeKey: string | undefined,
  ): void => {
    for (const entry of collapseActivityItems(items)) {
      if (isActivityRunEntry(entry)) {
        appendActivityRun(entry, containerKey, renderContext, zoneScopeKey);
        continue;
      }
      const item = entry;
      const indexed = indexNodes([item.node]);
      const selectionPoolOffset = selectionDescendantIds.length;
      selectionDescendantIds.push(...indexed.preorderIds);
      appendSessions({
        nodes: [item.node], containerKey, projectId: item.projectId, groupDirectory: item.groupDirectory,
        selectionScopeKey: null, zoneScopeKey, archived: false, renderContext,
        blockingBadgeSessionScopes: item.blockingBadgeSessionScopes,
        secondaryMeta: item.secondaryMeta, getSecondaryMeta: item.getSecondaryMeta, indexedNodes: indexed, selectionPoolOffset,
      });
    }
  };

  const appendChats = (): void => {
    if (!args.chatGroup) return;
    const chatsLoading = args.chatGroup.sessions.length === 0 && args.groupStatusByKey.get('activity:chats')?.state === 'loading';
    const collapsed = appendActivityHeader('chats', undefined, chatsLoading);
    if (collapsed) return;
    appendGroup(args.chatGroup, 'activity:chats', null, true, {
      initial: CHATS_INITIAL_LIMIT, increment: CHATS_INCREMENT, pinnedAlwaysVisible: true,
      renderContext: 'tree-chat', loadingInHeader: true,
    });
    if (args.archivedChatGroup) {
      appendGroup(args.archivedChatGroup, 'activity:chats:archived', null, false, { renderContext: 'tree-chat' });
    }
  };

  const zoneRenderContext: SessionSidebarRenderContext = args.detailedZoneRows ? 'timeline-mixed' : 'mixed-compact';

  const gatherRunMembers = (entries: readonly SessionSidebarWorkEntry[]): readonly SessionSidebarWorkEntry[] => {
    if (runIndex.runKeyBySessionId.size === 0) return entries;
    const runKeyOf = (entry: SessionSidebarWorkEntry): string | undefined => (
      entry.kind === 'session' ? runIndex.runKeyBySessionId.get(entry.item.node.session.id) : undefined
    );
    const membersByRun = new Map<string, SessionSidebarWorkEntry[]>();
    for (const entry of entries) {
      const runKey = runKeyOf(entry);
      if (runKey) membersByRun.set(runKey, [...(membersByRun.get(runKey) ?? []), entry]);
    }
    if (membersByRun.size === 0) return entries;
    const placed = new Set<string>();
    return entries.flatMap((entry) => {
      const runKey = runKeyOf(entry);
      if (!runKey) return [entry];
      if (placed.has(runKey)) return [];
      placed.add(runKey);
      return membersByRun.get(runKey) ?? [entry];
    });
  };

  const zoneBatchSize = args.sessionBatchSize ?? (args.hideDirectoryControls ? 10 : SESSIONS_INITIAL_LIMIT);
  const limitZoneEntries = (entries: readonly SessionSidebarWorkEntry[], containerKey: string) => {
    const requested = Math.max(zoneBatchSize, args.visibleCountByContainer.get(containerKey) ?? zoneBatchSize);
    let slots = 0;
    let lastRunKey: string | undefined;
    let cut = entries.length;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const runKey = entry.kind === 'session' ? runIndex.runKeyBySessionId.get(entry.item.node.session.id) : undefined;
      if (runKey !== undefined && runKey === lastRunKey) continue;
      lastRunKey = runKey;
      if (slots === requested) {
        cut = index;
        break;
      }
      slots += 1;
    }
    return { shown: entries.slice(0, cut), hidden: entries.slice(cut), requested, shownCount: slots };
  };

  const appendWorkEntries = (allEntries: readonly SessionSidebarWorkEntry[], containerKey: string, zoneScopeKey: string | undefined, limited = false): void => {
    const gathered = gatherRunMembers(allEntries);
    const { shown: entries, hidden, requested, shownCount } = limited && !search
      ? limitZoneEntries(gathered, containerKey)
      : { shown: gathered, hidden: EMPTY_WORK_ENTRIES, requested: 0, shownCount: 0 };
    let pending: SessionSidebarActivityItem[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      appendActivityItems(pending, containerKey, zoneRenderContext, zoneScopeKey);
      pending = [];
    };
    for (const entry of entries) {
      if (entry.kind === 'session') {
        pending.push(entry.item);
        continue;
      }
      flush();
      if (entry.kind === 'draft') {
        const detailed = args.detailedZoneRows === true;
        push({ kind: 'draft', key: keyFor(`${containerKey}:draft:${entry.draft.id}`), estimateSize: detailed ? TIMELINE_SESSION_ESTIMATE : SESSION_ESTIMATE, draft: entry.draft, depth: 0, projectId: entry.projectId, mixed: true, detailed });
        continue;
      }
      appendGroup(entry.group, entry.groupKey, entry.projectId, false, undefined, {
        keyPrefix: `${containerKey}:`, depth: 0, mixed: true, zoneScopeKey,
      });
    }
    flush();
    if (!limited || search) return;
    const more = hidden.length > 0;
    const fewer = requested > zoneBatchSize && shownCount > zoneBatchSize;
    if (!more && !fewer) return;
    const hiddenNodes = hidden.flatMap((entry) => (
      entry.kind === 'session' ? [entry.item.node]
        : entry.kind === 'group' ? entry.group.sessions.filter((node) => !isMovedToZone(node.session.id))
          : []
    ));
    if (zoneScopeKey && hiddenNodes.length > 0) {
      const indexed = indexNodes(hiddenNodes);
      const selectionPoolOffset = selectionDescendantIds.length;
      selectionDescendantIds.push(...indexed.preorderIds);
      appendFoldedSelection(hiddenNodes, indexed, selectionPoolOffset, zoneScopeKey, false);
    }
    push({ kind: 'show-control', key: `${containerKey}:show`, estimateSize: STATUS_ESTIMATE, more, fewer, hiddenNodes, containerKey, currentCount: shownCount, requestedCount: requested, increment: zoneBatchSize, depth: 0, flat: false, detailed: args.detailedZoneRows === true });
  };

  let pageRowCount = 0;
  const appendPages = (block: Extract<SessionSidebarBlock, { kind: 'pages' }>): void => {
    if (block.pages.length === 0) return;
    const start = rows.length;
    const collapsed = appendActivityHeader('pages');
    if (!collapsed) {
      for (const page of block.pages) {
        push({ kind: 'page', key: `page:${page.id}`, estimateSize: SESSION_ESTIMATE, pageId: page.id, open: page.open });
      }
    }
    pageRowCount += rows.length - start;
  };

  const appendPinned = (): void => {
    const pinnedItems = args.pinnedItems ?? [];
    const pinnedWorktrees = args.pinnedWorktrees ?? [];
    if (pinnedItems.length === 0 && pinnedWorktrees.length === 0) return;
    const collapsed = appendActivityHeader('pinned');
    if (collapsed) return;
    const entries: readonly SessionSidebarWorkEntry[] = [...pinnedItems.map((item) => ({ kind: 'session' as const, item })), ...pinnedWorktrees];
    appendWorkEntries(entries, PINNED_ZONE_KEY, PINNED_ZONE_KEY, true);
  };
  const appendWork = (): void => {
    const workEntries = args.workEntries ?? [];
    if (workEntries.length === 0) return;
    const collapsed = appendActivityHeader('work');
    if (!collapsed) appendWorkEntries(workEntries, 'activity:work', 'activity:work');
  };
  const appendCustom = (block: Extract<SessionSidebarBlock, { kind: 'custom' }>): void => {
    const entries = block.entries;
    if (entries.length === 0 && block.hideWhenEmpty && !block.preview) return;
    const activityKey = sidebarSectionActivityKey(block.id);
    const collapsed = appendActivityHeader(activityKey, { label: block.name, preview: block.preview });
    if (collapsed) return;
    if (entries.length === 0) {
      push({ kind: 'empty', key: `activity:${activityKey}:empty`, estimateSize: STATUS_ESTIMATE, emptyKind: 'section' });
      return;
    }
    appendWorkEntries(entries, `activity:${activityKey}`, `activity:${activityKey}`, true);
  };

  const selectedSection = args.singleProjectMode
    ? args.sections.find((section) => section.project.id === args.singleProjectId)
      ?? args.authoritativeSections.find((section) => section.project.id === args.singleProjectId)
    : undefined;
  const sections = args.singleProjectMode ? selectedSection ? [selectedSection] : [] : args.sections;

  const collectFiledWorktrees = (descriptors: ReturnType<typeof buildGroupRenderDescriptors>): Map<string, WorktreeInFolder> => {
    const worktreesByMemberId = new Map<string, WorktreeInFolder>();
    const rootGroup = descriptors.find((descriptor) => descriptor.group.isMain)?.group;
    const rootFolderMembers = new Set(rootGroup
      ? getSessionFolderScopes(rootGroup).flatMap(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).flatMap((folder) => folder.sessionIds))
      : []);
    for (const descriptor of descriptors) {
      const memberId = isGroupWork(descriptor.group) ? worktreeFolderMemberId(descriptor.group.directory) : null;
      if (!memberId || !rootFolderMembers.has(memberId)) continue;
      if (movedGroupKeys.has(descriptor.groupKey)) movedFolderMembers.add(memberId);
      else worktreesByMemberId.set(memberId, { group: descriptor.group, groupKey: descriptor.groupKey });
    }
    return worktreesByMemberId;
  };

  const appendProjectSections = (
    projectSections: readonly ProjectSection[],
    caption: { key: 'projects' | `section:${string}`; label?: string; preview?: boolean; always: boolean },
  ): void => {
    const captionHidden = !caption.always && (!args.projectsCaption || args.singleProjectMode || args.showOnlyMainWorkspace || (rows.length === 0 && !args.projectsCaptionAtTop && projectSections.length > 0));
    if (caption.always && projectSections.length === 0) {
      push({ kind: 'caption', key: `caption:${caption.key}`, estimateSize: SECTION_HEADER_ESTIMATE, caption: caption.key, collapsed: false, label: caption.label, preview: caption.preview });
      push({ kind: 'empty', key: `caption:${caption.key}:empty`, estimateSize: STATUS_ESTIMATE, emptyKind: 'section' });
      return;
    }
    if (!captionHidden && sections.length > 0) {
      const collapseKey = caption.key === 'projects' ? PROJECTS_CAPTION_COLLAPSE_KEY : caption.key;
      const captionCollapsed = args.collapsedActivities.has(collapseKey);
      push({ kind: 'caption', key: `caption:${caption.key}`, estimateSize: SECTION_HEADER_ESTIMATE, caption: caption.key, collapsed: captionCollapsed, label: caption.label, preview: caption.preview });
      if (captionCollapsed) return;
    }
    for (const section of projectSections) {
      const descriptors = buildGroupRenderDescriptors(section, { mainWorkspaceOnly: args.showOnlyMainWorkspace });
      const projectCollapsed = !args.singleProjectMode && !args.showOnlyMainWorkspace && args.collapsedProjects.has(section.project.id);
      if (!args.showOnlyMainWorkspace) {
        const rowIndex = rows.length;
        push({ kind: 'project-header', key: `project:${section.project.id}:header`, estimateSize: SECTION_HEADER_ESTIMATE, section, collapsed: projectCollapsed });
        stickyHeaders.push(Object.freeze({ rowIndex, kind: 'project', id: section.project.id }));
      }
      if (projectCollapsed) continue;
      const worktreesByMemberId = collectFiledWorktrees(descriptors);
      const filedGroupKeys = new Set([...worktreesByMemberId.values()].map((entry) => entry.groupKey));
      const hasRootGroup = descriptors.some((descriptor) => descriptor.group.isMain);
      const listedWorktrees = hasRootGroup ? descriptors
        .filter((descriptor) => isGroupWork(descriptor.group)
          && !movedGroupKeys.has(descriptor.groupKey) && !filedGroupKeys.has(descriptor.groupKey))
        .map((descriptor): WorktreeInFolder => ({ group: descriptor.group, groupKey: descriptor.groupKey })) : [];
      const listedGroupKeys = new Set(listedWorktrees.map((entry) => entry.groupKey));
      for (const descriptor of descriptors) {
        if (movedGroupKeys.has(descriptor.groupKey) || filedGroupKeys.has(descriptor.groupKey) || listedGroupKeys.has(descriptor.groupKey)) continue;
        appendGroup(descriptor.group, descriptor.groupKey, descriptor.projectId, descriptor.hideGroupLabel, undefined, PROJECT_PLACEMENT,
          descriptor.group.isMain ? worktreesByMemberId : undefined, descriptor.group.isMain ? listedWorktrees : undefined);
      }
    }
  };

  const appendProjectGroup = (block: Extract<SessionSidebarBlock, { kind: 'project-group' }>): void => {
    if (args.singleProjectMode || args.showOnlyMainWorkspace) return;
    const byId = new Map(args.sections.map((section) => [section.project.id, section]));
    const projectSections = block.projectIds.flatMap((id) => byId.get(id) ?? []);
    if (projectSections.length === 0 && block.hideWhenEmpty && !block.preview) return;
    appendProjectSections(projectSections, { key: sidebarSectionActivityKey(block.id), label: block.name, preview: block.preview, always: true });
  };

  const appendProjects = (block: Extract<SessionSidebarBlock, { kind: 'projects' }>): void => {
    const excluded = block.excludedProjectIds;
    const timeEntries = args.singleProjectMode ? null : args.timeEntries ?? null;
    if (timeEntries) {
      const entries = timeEntries;
      const foldered = args.sections.flatMap((section) => {
        const rootGroup = section.groups.find((group) => group.isMain);
        const hasFolders = rootGroup && !excluded?.has(section.project.id)
          && getSessionFolderScopes(rootGroup).some(({ scopeKey }) => (args.foldersMap[scopeKey] ?? EMPTY_FOLDERS).length > 0);
        return hasFolders ? [{ section, rootGroup }] : [];
      });
      if (entries.length > 0 || foldered.length > 0) {
        const collapsed = appendActivityHeader('timeline');
        if (!collapsed) {
          for (const { section, rootGroup } of foldered) {
            const filedWorktrees = collectFiledWorktrees(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: false }));
            appendGroup(rootGroup, `${section.project.id}:${rootGroup.id}`, section.project.id, true, undefined, {
              keyPrefix: 'activity:timeline:', depth: 0, mixed: args.sections.length > 1, foldersOnly: true,
            }, filedWorktrees);
          }
          appendWorkEntries(entries, 'activity:timeline', 'activity:timeline');
        }
      }
      if (!((entries.length > 0 || foldered.length > 0) && args.collapsedActivities.has('timeline'))) {
        const listedProjects = new Set(timeEntries.map((entry) => entry.kind === 'session' ? entry.item.projectId : entry.projectId));
        const shown = new Set<string>();
        for (const section of args.sections) {
          if (listedProjects.has(section.project.id) || excluded?.has(section.project.id)) continue;
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
      return;
    }
    let projectSections = excluded && excluded.size > 0 && !args.singleProjectMode
      ? sections.filter((section) => !excluded.has(section.project.id))
      : [...sections];
    if (args.showOnlyMainWorkspace) {
      const active = projectSections.find((section) => section.project.id === args.activeProjectId) ?? projectSections[0];
      projectSections = active ? [active] : [];
    }
    appendProjectSections(projectSections, { key: 'projects', always: false });
  };

  const appendFlatSearch = (): void => {
    const results = args.contentSearchResults ?? [];
    const appendResult = (result: ConversationResult): void => {
      const key = `search-result:${result.sessionId}`;
      const scopeKey = args.searchLocationById?.get(result.sessionId)?.projectId ?? null;
      selectionEntries.push({ id: result.sessionId, rowKey: key, scopeKey, archived: result.archived });
      push({ kind: 'search-result', key, estimateSize: searchRowEstimate(Boolean(result.excerpt)), result, context: searchContext(result) });
    };
    const appendSection = (section: SearchResultSection, sectionResults: readonly ConversationResult[], initial: number): void => {
      const shown = args.revealedSearchSections?.has(section) ? sectionResults.length : Math.min(sectionResults.length, initial);
      for (let index = 0; index < shown; index += 1) appendResult(sectionResults[index]);
      if (shown < sectionResults.length) push({ kind: 'search-show-more', key: `search:${section}:more`, estimateSize: STATUS_ESTIMATE, section, hidden: sectionResults.length - shown });
      else if (args.searchSectionsWithMore?.has(section)) push({ kind: 'search-more', key: `search:${section}:page`, estimateSize: 36, section });
    };
    appendSection('active', results.filter((result) => !result.archived), ACTIVE_SEARCH_INITIAL);
    const archived = results.filter((result) => result.archived);
    if (archived.length === 0 && !args.searchSectionsWithMore?.has('archived')) return;
    stickyHeaders.push(Object.freeze({ rowIndex: rows.length, kind: 'search', id: 'archived' }));
    push({ kind: 'search-archived-caption', key: 'search:archived', estimateSize: SECTION_HEADER_ESTIMATE });
    appendSection('archived', archived, archived.length);
  };

  if (search) appendFlatSearch();
  else for (const block of args.blocks ?? DEFAULT_BLOCKS) {
    switch (block.kind) {
      case 'pages': appendPages(block); break;
      case 'chats': appendChats(); break;
      case 'pinned': appendPinned(); break;
      case 'work': appendWork(); break;
      case 'custom': appendCustom(block); break;
      case 'project-group': appendProjectGroup(block); break;
      case 'projects': appendProjects(block); break;
    }
  }

  if ((!search || !args.searchIncomplete) && rows.length === pageRowCount) {
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
    folderOwnerKeyBySessionId,
    sessionById,
    selectionWorks: Object.freeze([...selectionWorks.values()]),
    search,
    searchMatchCount: search ? args.contentSearchResults?.length ?? 0 : 0,
  });
};
