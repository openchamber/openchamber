import { normalizePath } from '@/lib/pathNormalization';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '../types';
import { getSessionFolderIdentityKey, getSessionSelectionScopeKey } from './sessionFolderIdentity';

/**
 * One row in the sidebar's logical render order. Selection (shift range,
 * Ctrl/Cmd+A, bulk scope) reads these entries instead of scanning
 * `[data-session-row]` nodes, so rows that virtualization keeps unmounted
 * participate exactly like mounted ones.
 */
export type SessionRowOrderEntry = {
  id: string;
  /** Stable identity of this rendered occurrence, distinct from the session id. */
  rowKey: string;
  scopeKey: string | null;
  archived: boolean;
};

/**
 * Build the row key used by a normal session tree. The container identifies
 * the rendered list (group, folder, or activity item), while the occurrence
 * disambiguates duplicate session ids in that list.
 */
const createSessionRowKey = (
  containerKey: string,
  sessionId: string,
  occurrence = 0,
): string => {
  const baseKey = `${containerKey}:session:${sessionId}`;
  return occurrence === 0 ? baseKey : `${baseKey}:${occurrence}`;
};

const createSessionChildRowKey = (
  parentRowKey: string,
  sessionId: string,
  occurrence = 0,
): string => {
  const baseKey = `${parentRowKey}/child:${sessionId}`;
  return occurrence === 0 ? baseKey : `${baseKey}:${occurrence}`;
};

/**
 * Canonical container key for normal folder session rows. Folder ids are only
 * unique within their scoped folder identity, so keep that identity intact in
 * the row key instead of rebuilding it with another separator.
 */
export const getSessionFolderRowContainerKey = (
  groupKey: string,
  scopeKey: string,
  folderId: string,
): string => `${groupKey}:folder:${getSessionFolderIdentityKey(scopeKey, folderId)}`;

/**
 * Archived virtual rows already use this key in the committed virtual model.
 * Keep it as a compatibility path while normal-flow rows move to the scoped
 * folder identity above.
 */
const getSessionVirtualFolderRowContainerKey = (
  groupKey: string,
  scopeKey: string,
  folderId: string,
): string => `${groupKey}:folder:${scopeKey}:${folderId}`;

/** Root occurrence keys for one normal session-tree list. */
export const getSessionNodeRowKeys = (
  containerKey: string,
  nodes: readonly SessionNode[],
): string[] => {
  const occurrences = new Map<string, number>();
  return nodes.map((node) => {
    const baseKey = createSessionRowKey(containerKey, node.session.id);
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    return createSessionRowKey(containerKey, node.session.id, occurrence);
  });
};

/** Child occurrence keys derived from the current rendered parent row. */
export const getSessionChildRowKeys = (
  parentRowKey: string,
  children: readonly SessionNode[],
): string[] => {
  const occurrences = new Map<string, number>();
  return children.map((child) => {
    const baseKey = createSessionChildRowKey(parentRowKey, child.session.id);
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    return createSessionChildRowKey(parentRowKey, child.session.id, occurrence);
  });
};

type SessionRowOrderRenderContext = 'project' | 'recent';

type AppendSessionNodeRowsOptions = {
  /** Project id when the rows belong to a project section. */
  projectId: string | null | undefined;
  /** Directory fallback matching the row's `groupDirectory` prop. */
  fallbackDirectory: string | null | undefined;
  /** Logical selection scope, separate from the row's operational directory. */
  selectionScopeKey?: string | null;
  renderContext: SessionRowOrderRenderContext;
  archived: boolean;
  hasSessionSearchQuery: boolean;
  expandedParents: ReadonlySet<string>;
  /** Stable row-key container for this rendered list. */
  rowKeyContainerKey?: string;
};

const expansionKeyFor = (
  renderContext: SessionRowOrderRenderContext,
  archived: boolean,
  sessionId: string,
): string => `${renderContext}:${archived ? 'archived' : 'active'}:${sessionId}`;

type SessionNodeRowTraversalOptions = {
  renderContext: SessionRowOrderRenderContext;
  archived: boolean;
  hasSessionSearchQuery: boolean;
  expandedParents: ReadonlySet<string>;
  fallbackDirectory: string | null | undefined;
  rowKeyContainerKey: string;
};

type SessionNodeRowVisitor = (
  node: SessionNode,
  rowKey: string,
  depth: number,
  inheritedDirectory: string | null | undefined,
) => void;

const visitSessionNodeRows = (
  nodes: readonly SessionNode[],
  options: SessionNodeRowTraversalOptions,
  visitor: SessionNodeRowVisitor,
): void => {
  const rootRowKeys = getSessionNodeRowKeys(options.rowKeyContainerKey, nodes);
  const visit = (
    node: SessionNode,
    inheritedDirectory: string | null | undefined,
    rowKey: string,
    depth: number,
  ): void => {
    visitor(node, rowKey, depth, inheritedDirectory);
    if (!options.hasSessionSearchQuery && !options.expandedParents.has(
      expansionKeyFor(options.renderContext, options.archived, node.session.id),
    )) {
      return;
    }
    // SessionTreeItem threads the nearest directory down to child rows; a
    // child without its own directory uses its parent's, not the group's.
    const childDirectory = node.session.directory ?? inheritedDirectory;
    const childRowKeys = getSessionChildRowKeys(rowKey, node.children);
    node.children.forEach((child, index) => {
      const childRowKey = childRowKeys[index];
      if (!childRowKey) return;
      visit(child, childDirectory, childRowKey, depth + 1);
    });
  };

  nodes.forEach((node, index) => {
    const rowKey = rootRowKeys[index];
    if (!rowKey) return;
    visit(node, options.fallbackDirectory, rowKey, 0);
  });
};

/**
 * Append the depth-first document order of `nodes`, mirroring
 * `SessionNodeItem`'s render/expansion rule exactly: a node's children follow
 * it only while the node is expanded, and a search forces every row expanded.
 * Entries follow the same inclusion rules as the rendered session tree.
 */
export const appendSessionNodeRowEntries = (
  out: SessionRowOrderEntry[],
  nodes: readonly SessionNode[],
  options: AppendSessionNodeRowsOptions,
): void => {
  const rowKeyContainerKey = options.rowKeyContainerKey
    ?? `${options.renderContext}:${options.archived ? 'archived' : 'active'}:${normalizePath(options.fallbackDirectory ?? null) ?? 'unscoped'}`;
  visitSessionNodeRows(nodes, {
    renderContext: options.renderContext,
    archived: options.archived,
    hasSessionSearchQuery: options.hasSessionSearchQuery,
    expandedParents: options.expandedParents,
    fallbackDirectory: options.fallbackDirectory,
    rowKeyContainerKey,
  }, (node, rowKey, _depth, inheritedDirectory) => {
    const scopeKey = options.selectionScopeKey !== undefined
      ? options.selectionScopeKey
      : getSessionSelectionScopeKey(
        options.projectId,
        node.session.directory ?? inheritedDirectory,
      );
    out.push({ id: node.session.id, rowKey, scopeKey, archived: options.archived });
  });
};

export type SessionRowOrderFolderEntry = {
  folder: { id: string; name?: string; parentId?: string | null };
  scopeKey: string;
  scopeDirectory: string | null;
  nodes: readonly SessionNode[];
};

type SessionGroupRowOrderInput = {
  groupKey: string;
  /** Outside search, a collapsed group renders no rows at all. */
  isCollapsed: boolean;
  hasSessionSearchQuery: boolean;
  collapsedFolderIds: ReadonlySet<string>;
  expandedParents: ReadonlySet<string>;
  archivedBucket: boolean;
  projectId: string | null | undefined;
  groupDirectory: string | null | undefined;
  /** Logical selection scope for every row in this group. */
  selectionScopeKey?: string | null;
  rootFolders: readonly SessionRowOrderFolderEntry[];
  childFoldersByParentId: ReadonlyMap<string, readonly SessionRowOrderFolderEntry[]>;
  visibleSessions: readonly SessionNode[];
  /**
   * Normal-flow rows use the scoped folder identity. Large archived virtual
   * rows leave this unset to retain their established occurrence keys.
   */
  useCanonicalFolderRowKeys?: boolean;
};

export type SessionGroupRenderRow =
  | {
    kind: 'folder-header';
    key: string;
    entry: SessionRowOrderFolderEntry;
    displayName: string;
  }
  | {
    kind: 'folder-empty';
    key: string;
    entry: SessionRowOrderFolderEntry;
  }
  | {
    kind: 'session';
    key: string;
    node: SessionNode;
    depth: number;
    /** Directory fallback threaded to SessionTreeItem for this occurrence. */
    groupDirectory: string | null;
  };

type SessionGroupRenderRowModel = {
  rows: readonly SessionGroupRenderRow[];
  entries: readonly SessionRowOrderEntry[];
};

const EMPTY_SESSION_GROUP_RENDER_ROW_MODEL: SessionGroupRenderRowModel = {
  rows: [],
  entries: [],
};

/**
 * Build the one flat row model used by a large archived group. Folder headers,
 * empty-folder bodies, and every visible session occurrence share this model so
 * a folder body cannot bypass the group's virtual window.
 */
export const buildSessionGroupRenderRowModel = (
  input: SessionGroupRowOrderInput,
): SessionGroupRenderRowModel => {
  if (input.isCollapsed) return EMPTY_SESSION_GROUP_RENDER_ROW_MODEL;

  const rows: SessionGroupRenderRow[] = [];
  const entries: SessionRowOrderEntry[] = [];
  const expansion = {
    renderContext: 'project' as const,
    archived: input.archivedBucket,
    hasSessionSearchQuery: input.hasSessionSearchQuery,
    expandedParents: input.expandedParents,
  };
  const appendSessionRows = (
    nodes: readonly SessionNode[],
    fallbackDirectory: string | null | undefined,
    rowKeyContainerKey: string,
  ): void => {
    visitSessionNodeRows(nodes, {
      ...expansion,
      fallbackDirectory,
      rowKeyContainerKey,
    }, (node, rowKey, depth, inheritedDirectory) => {
      const scopeKey = input.selectionScopeKey !== undefined
        ? input.selectionScopeKey
        : getSessionSelectionScopeKey(
          input.projectId,
          node.session.directory ?? inheritedDirectory,
        );
      rows.push({
        kind: 'session',
        key: rowKey,
        node,
        depth,
        groupDirectory: inheritedDirectory ?? null,
      });
      entries.push({
        id: node.session.id,
        rowKey,
        scopeKey,
        archived: input.archivedBucket,
      });
    });
  };

  const visitedFolders = new Set<string>();
  const useCanonicalFolderRowKeys = input.useCanonicalFolderRowKeys ?? !input.archivedBucket;
  const visitFolder = (entry: SessionRowOrderFolderEntry, parentPath: string): void => {
    const folderKey = getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id);
    if (visitedFolders.has(folderKey)) return;
    visitedFolders.add(folderKey);

    const folderName = entry.folder.name ?? entry.folder.id;
    const displayName = parentPath ? `${parentPath} / ${folderName}` : folderName;
    const folderRowKey = useCanonicalFolderRowKeys
      ? getSessionFolderRowContainerKey(input.groupKey, entry.scopeKey, entry.folder.id)
      : getSessionVirtualFolderRowContainerKey(input.groupKey, entry.scopeKey, entry.folder.id);
    rows.push({ kind: 'folder-header', key: folderRowKey, entry, displayName });

    if (!input.hasSessionSearchQuery && input.collapsedFolderIds.has(folderKey)) return;
    if (entry.nodes.length === 0) {
      rows.push({ kind: 'folder-empty', key: `${folderRowKey}:empty`, entry });
    } else {
      appendSessionRows(
        entry.nodes,
        entry.scopeDirectory ?? input.groupDirectory,
        folderRowKey,
      );
    }
    (input.childFoldersByParentId.get(folderKey) ?? []).forEach((child) => visitFolder(child, displayName));
  };

  input.rootFolders.forEach((entry) => visitFolder(entry, ''));
  appendSessionRows(input.visibleSessions, input.groupDirectory, input.groupKey);
  return { rows, entries };
};

/**
 * Mirror `SessionGroupSection`'s body order: folders first (each folder's own
 * nodes, then its child folders; a collapsed folder hides its whole subtree),
 * then the ungrouped sessions already sliced by the show-more limit.
 */
export const buildSessionGroupRowOrderEntries = (
  input: SessionGroupRowOrderInput,
): SessionRowOrderEntry[] => [...buildSessionGroupRenderRowModel({
  ...input,
  useCanonicalFolderRowKeys: true,
}).entries];

type SessionRowOrderActivityItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  selectionScopeKey?: string | null;
};

const activityRowContainerKey = (
  item: SessionRowOrderActivityItem,
  sectionKey: string,
  occurrence: number,
): string => `activity:${sectionKey}:${item.node.session.id}:${occurrence}`;

const activityRowKey = (
  item: SessionRowOrderActivityItem,
  sectionKey: string,
  occurrence: number,
): string => createSessionRowKey(
  activityRowContainerKey(item, sectionKey, occurrence),
  item.node.session.id,
);

const buildActivityRootOccurrences = (
  items: readonly SessionRowOrderActivityItem[],
  visibleLimit: number,
): number[] => {
  const occurrences = new Map<string, number>();
  return items.slice(0, visibleLimit).map((item) => {
    const sessionId = item.node.session.id;
    const occurrence = occurrences.get(sessionId) ?? 0;
    occurrences.set(sessionId, occurrence + 1);
    return occurrence;
  });
};

const buildActivityRootRowKeys = (
  items: readonly SessionRowOrderActivityItem[],
  visibleLimit: number,
  sectionKey: string,
): string[] => {
  const visibleItems = items.slice(0, visibleLimit);
  const occurrences = buildActivityRootOccurrences(visibleItems, visibleItems.length);
  return visibleItems.map((item, index) => activityRowKey(item, sectionKey, occurrences[index] ?? 0));
};

/** Root occurrence keys for one Recent/activity section. */
export const buildActivitySessionRowKeys = (
  items: readonly SessionRowOrderActivityItem[],
  options: { visibleLimit: number; sectionKey?: string },
): string[] => {
  return buildActivityRootRowKeys(items, options.visibleLimit, options.sectionKey ?? 'active-now');
};

/**
 * Mirror `SidebarActivitySections`: each section renders at most
 * `visibleLimit` items, and every item follows the Recent expansion keys
 * (`recent:active:<id>`).
 */
export const buildActivityRowOrderEntries = (
  items: readonly SessionRowOrderActivityItem[],
  options: {
    visibleLimit: number;
    hasSessionSearchQuery: boolean;
    expandedParents: ReadonlySet<string>;
    sectionKey?: string;
  },
): SessionRowOrderEntry[] => {
  const out: SessionRowOrderEntry[] = [];
  const sectionKey = options.sectionKey ?? 'active-now';
  const visibleItems = items.slice(0, options.visibleLimit);
  const occurrences = buildActivityRootOccurrences(visibleItems, visibleItems.length);
  visibleItems.forEach((item, index) => {
    appendSessionNodeRowEntries(out, [item.node], {
      projectId: item.projectId,
      fallbackDirectory: item.groupDirectory,
      selectionScopeKey: item.selectionScopeKey,
      renderContext: 'recent',
      archived: false,
      hasSessionSearchQuery: options.hasSessionSearchQuery,
      expandedParents: options.expandedParents,
      rowKeyContainerKey: activityRowContainerKey(item, sectionKey, occurrences[index] ?? 0),
    });
  });
  return out;
};

type SessionRowOrderBulkSelection = {
  ids: string[];
  scopeKey: string | null;
};

/**
 * Ctrl/Cmd+A target: every registered row in the selection scope. The store's
 * explicit scope wins; without one the first rendered entry decides, matching
 * the previous DOM behavior.
 */
export const deriveSessionRowBulkSelectAll = (
  entries: readonly SessionRowOrderEntry[],
  currentScopeKey: string | null,
): SessionRowOrderBulkSelection | null => {
  const firstEntry = entries[0];
  if (!firstEntry) return null;
  const scopeKey = currentScopeKey ?? firstEntry.scopeKey;
  const ids = entries
    .filter((entry) => !scopeKey || entry.scopeKey === scopeKey)
    .map((entry) => entry.id);
  if (ids.length === 0) return null;
  return { ids, scopeKey };
};

/**
 * Bulk delete versus archive: archived only when every selected session is
 * authoritatively archived. A selected id missing from that authority is
 * treated as active so an incomplete sidebar projection cannot trigger a hard
 * delete. When the authoritative map is unavailable, the registry can only
 * classify IDs it contains; an absent ID is still treated as active.
 */
export const deriveSessionRowSelectionArchived = (
  entries: readonly SessionRowOrderEntry[],
  selectedIds: ReadonlySet<string>,
  selectedSessionsById?: ReadonlyMap<string, Session>,
): boolean => {
  let sawActive = false;
  let sawArchived = false;

  if (selectedSessionsById) {
    for (const id of selectedIds) {
      const session = selectedSessionsById.get(id);
      if (!session || !session.time?.archived) sawActive = true;
      else sawArchived = true;
      if (sawArchived && sawActive) return false;
    }
    return sawArchived && !sawActive;
  }

  const archivedById = new Map<string, boolean>();
  for (const entry of entries) {
    if (selectedIds.has(entry.id) && !archivedById.has(entry.id)) {
      archivedById.set(entry.id, entry.archived);
    }
  }
  for (const id of selectedIds) {
    const archived = archivedById.get(id);
    if (archived === undefined) sawActive = true;
    else if (archived) sawArchived = true;
    else sawActive = true;
    if (sawArchived && sawActive) return false;
  }
  return sawArchived && !sawActive;
};

/**
 * First selected id, in the selection Set's insertion order, whose first
 * render-order entry has a non-empty scope — matching the previous DOM scan
 * (probe the first matching row per selected id, skip empty scopes). A
 * duplicated id's later entries are never considered once its first entry is
 * known.
 */
export const deriveSessionRowSelectionScope = (
  entries: readonly SessionRowOrderEntry[],
  selectedIds: ReadonlySet<string>,
): string | null => {
  const firstEntryById = new Map<string, SessionRowOrderEntry>();
  for (const entry of entries) {
    if (!firstEntryById.has(entry.id)) firstEntryById.set(entry.id, entry);
  }
  for (const id of selectedIds) {
    const scope = firstEntryById.get(id)?.scopeKey;
    if (scope && scope.length > 0) return scope;
  }
  return null;
};
