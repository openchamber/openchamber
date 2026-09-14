import { normalizePath } from '@/lib/pathNormalization';
import type { SessionNode } from '../types';

/**
 * One row in the sidebar's logical render order. Selection (shift range,
 * Ctrl/Cmd+A, bulk scope) reads these entries instead of scanning
 * `[data-session-row]` nodes, so rows that virtualization keeps unmounted
 * participate exactly like mounted ones.
 */
export type SessionRowOrderEntry = {
  id: string;
  scopeKey: string | null;
  archived: boolean;
};

/** One flattened render row: the node plus its `SessionTreeItem` depth. */
export type SessionRowOrderItem = {
  node: SessionNode;
  depth: number;
};

type SessionRowOrderRenderContext = 'project' | 'recent';

type AppendSessionNodeRowsOptions = {
  /** Project id when the rows belong to a project section. */
  projectId: string | null | undefined;
  /** Directory fallback matching the row's `groupDirectory` prop. */
  fallbackDirectory: string | null | undefined;
  renderContext: SessionRowOrderRenderContext;
  archived: boolean;
  hasSessionSearchQuery: boolean;
  expandedParents: ReadonlySet<string>;
  /** When provided, flattened render items are collected alongside entries. */
  items?: SessionRowOrderItem[] | null;
};

const expansionKeyFor = (
  renderContext: SessionRowOrderRenderContext,
  archived: boolean,
  sessionId: string,
): string => `${renderContext}:${archived ? 'archived' : 'active'}:${sessionId}`;

/**
 * Append the depth-first document order of `nodes`, mirroring
 * `SessionNodeItem`'s render/expansion rule exactly: a node's children follow
 * it only while the node is expanded, and a search forces every row expanded.
 * Entries always follow the inclusion rules; `items` additionally records the
 * flattened row order (node + depth) for renderers that mount rows
 * individually.
 */
export const appendSessionNodeRowEntries = (
  out: SessionRowOrderEntry[],
  nodes: readonly SessionNode[],
  options: AppendSessionNodeRowsOptions,
): void => {
  const items = options.items ?? null;
  const visit = (node: SessionNode, inheritedDirectory: string | null | undefined, depth: number): void => {
    const scopeKey = options.projectId
      ?? normalizePath(node.session.directory ?? null)
      ?? normalizePath(inheritedDirectory);
    out.push({ id: node.session.id, scopeKey, archived: options.archived });
    if (items) items.push({ node, depth });
    if (!options.hasSessionSearchQuery && !options.expandedParents.has(
      expansionKeyFor(options.renderContext, options.archived, node.session.id),
    )) {
      return;
    }
    // SessionTreeItem threads the nearest directory down to child rows; a
    // child without its own directory uses its parent's, not the group's.
    const childDirectory = node.session.directory ?? inheritedDirectory;
    node.children.forEach((child) => visit(child, childDirectory, depth + 1));
  };
  nodes.forEach((node) => visit(node, options.fallbackDirectory, 0));
};

export type SessionRowOrderFolderEntry = {
  folder: { id: string };
  scopeDirectory: string | null;
  nodes: readonly SessionNode[];
};

type SessionGroupRowOrderInput = {
  /** Outside search, a collapsed group renders no rows at all. */
  isCollapsed: boolean;
  hasSessionSearchQuery: boolean;
  collapsedFolderIds: ReadonlySet<string>;
  expandedParents: ReadonlySet<string>;
  archivedBucket: boolean;
  projectId: string | null | undefined;
  groupDirectory: string | null | undefined;
  rootFolders: readonly SessionRowOrderFolderEntry[];
  childFoldersByParentId: ReadonlyMap<string, readonly SessionRowOrderFolderEntry[]>;
  visibleSessions: readonly SessionNode[];
};

type SessionGroupRowModel = {
  /** Every rendered row in document order; selection reads these. */
  entries: SessionRowOrderEntry[];
  /**
   * Flattened rows for the region the virtualizer owns — the ungrouped
   * sessions. Folder rows keep rendering in normal flow above the virtual
   * list, so they stay out of `items` rather than duplicating their content.
   */
  items: SessionRowOrderItem[];
};

/**
 * Mirror `SessionGroupSection`'s body order: folders first (each folder's own
 * nodes, then its child folders; a collapsed folder hides its whole subtree),
 * then the ungrouped sessions already sliced by the show-more limit. Entries
 * cover every rendered row; items cover only the ungrouped region the
 * virtual list mounts, flattened to one row per retained session.
 */
export const buildSessionGroupRowModel = (
  input: SessionGroupRowOrderInput,
): SessionGroupRowModel => {
  if (input.isCollapsed) return { entries: [], items: [] };

  const entries: SessionRowOrderEntry[] = [];
  const items: SessionRowOrderItem[] = [];
  const expansion = {
    renderContext: 'project' as const,
    archived: input.archivedBucket,
    hasSessionSearchQuery: input.hasSessionSearchQuery,
    expandedParents: input.expandedParents,
  };
  const visited = new Set<string>();
  const visitFolder = (entry: SessionRowOrderFolderEntry): void => {
    if (visited.has(entry.folder.id)) return;
    visited.add(entry.folder.id);
    // A collapsed folder hides its own session rows along with every child
    // folder; SessionFolderItem only renders `nodes` while expanded.
    if (!input.hasSessionSearchQuery && input.collapsedFolderIds.has(entry.folder.id)) return;
    appendSessionNodeRowEntries(entries, entry.nodes, {
      ...expansion,
      projectId: input.projectId,
      fallbackDirectory: entry.scopeDirectory ?? input.groupDirectory,
    });
    (input.childFoldersByParentId.get(entry.folder.id) ?? []).forEach(visitFolder);
  };
  input.rootFolders.forEach(visitFolder);
  appendSessionNodeRowEntries(entries, input.visibleSessions, {
    ...expansion,
    projectId: input.projectId,
    fallbackDirectory: input.groupDirectory,
    items,
  });
  return { entries, items };
};

type SessionRowOrderActivityItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
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
  },
): SessionRowOrderEntry[] => {
  const out: SessionRowOrderEntry[] = [];
  for (const item of items.slice(0, options.visibleLimit)) {
    appendSessionNodeRowEntries(out, [item.node], {
      projectId: item.projectId,
      fallbackDirectory: item.groupDirectory,
      renderContext: 'recent',
      archived: false,
      hasSessionSearchQuery: options.hasSessionSearchQuery,
      expandedParents: options.expandedParents,
    });
  }
  return out;
};

export const toSessionRowOrderIds = (entries: readonly SessionRowOrderEntry[]): string[] => (
  entries.map((entry) => entry.id)
);

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
 * Bulk delete versus archive: archived only when every selected registered row
 * is archived. Selected ids with no registered row are ignored, like the
 * previous DOM scan of unmounted rows.
 */
export const deriveSessionRowSelectionArchived = (
  entries: readonly SessionRowOrderEntry[],
  selectedIds: ReadonlySet<string>,
): boolean => {
  let sawActive = false;
  let sawArchived = false;
  for (const entry of entries) {
    if (!selectedIds.has(entry.id)) continue;
    if (entry.archived) sawArchived = true;
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
