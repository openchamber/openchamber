import { getRuntimeKey } from '@/lib/runtime-switch';
import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import { normalizePath } from '@/lib/pathNormalization';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '../types';
import { getSessionFolderIdentityKey } from './sessionFolderIdentity';

/**
 * Per-row render extras precomputed once per group render and threaded down to
 * each `SessionNodeItem`. Hoisting these out of the row `React.memo` comparator
 * turns an O(rows × subtree-depth) walk into per-row `Set.has`/string compares.
 *
 * The child variant intentionally omits `childRenderExtrasFor` — the resolver is
 * shared from the group and re-passed, so it does not need to recurse through
 * each child's extras object.
 */
export type SessionNodeChildRenderExtras = {
  subtreeContainsEditing: Set<string>;
  menuOpenSessionId: string | null;
  nodeStructureKey: string;
  /**
   * Bumped once a minute by the owning list so rows that render a relative
   * timestamp ("5m") re-render and recompute it. Only the Recent list
   * supplies it; elsewhere the rows carry no time-dependent label.
   */
  relativeTimeTick?: number;
};

export type SessionNodeRenderExtras<TNode = SessionNode> = SessionNodeChildRenderExtras & {
  childRenderExtrasFor?: (child: TNode) => SessionNodeChildRenderExtras;
};

/**
 * Walk `nodes` and add `node.session.id` to `result` for every node
 * whose subtree contains `targetId`. This is used to precompute, once
 * per SessionGroupSection render, which rows need to update when
 * `editingId` changes. With M visible rows, this
 * turns an O(M × subtree-depth) walk inside `SessionNodeItem.areEqual`
 * into a single O(M) `Set.has` per row.
 */
export const collectSubtreeContainingId = (
  nodes: SessionNode[],
  targetId: string | null,
  result: Set<string>,
): void => {
  if (!targetId) return;

  const visit = (node: SessionNode): boolean => {
    let containsTarget = node.session.id === targetId;
    for (const child of node.children) {
      containsTarget = visit(child) || containsTarget;
    }
    if (containsTarget) {
      result.add(node.session.id);
    }
    return containsTarget;
  };

  for (const node of nodes) {
    visit(node);
  }
};

export const nodeContainsSessionId = (node: SessionNode, sessionId: string | null): boolean => {
  if (!sessionId) {
    return false;
  }

  if (node.session.id === sessionId) {
    return true;
  }

  for (const child of node.children) {
    if (nodeContainsSessionId(child, sessionId)) {
      return true;
    }
  }

  return false;
};

export type QuestionBadgeSessionScope = {
  directory: string;
  sessionIDs: string[];
};

export const canShowSessionWorktreeMenu = ({
  isSubtaskSession,
  archivedBucket,
  isVSCode,
  sessionDirectory,
}: {
  isSubtaskSession: boolean;
  archivedBucket: boolean;
  isVSCode: boolean;
  sessionDirectory: string | null;
}): boolean => !isSubtaskSession
  && !archivedBucket
  && !isVSCode
  && !isChatDirectoryPath(sessionDirectory);

export const getSessionWorktreeMenuDisabled = ({
  sessionDirectory,
  isStreaming,
  isMovingToWorktree,
}: {
  sessionDirectory: string | null;
  isStreaming: boolean;
  isMovingToWorktree: boolean;
}): boolean => !sessionDirectory || isStreaming || isMovingToWorktree;

/**
 * Choose which (directory, sessionIDs) scopes a sidebar row's pending-question
 * badge should count. An expanded row counts only its own session; a collapsed
 * parent row additionally rolls up the hidden descendants of its subtree,
 * grouped by the directory store each descendant actually lives in, so badges
 * stay correct for worktree/subtask sessions without bootstrapping their
 * directory stores.
 */
export const selectQuestionBadgeSessionScopes = (
  node: SessionNode,
  isExpanded: boolean,
  fallbackDirectory: string | null,
): QuestionBadgeSessionScope[] => {
  const sessionIDsByDirectory = new Map<string, string[]>();
  const visit = (current: SessionNode): void => {
    const directory = resolveGlobalSessionDirectory(current.session)
      ?? normalizePath(current.worktree?.path)
      ?? fallbackDirectory;
    if (directory) {
      const sessionIDs = sessionIDsByDirectory.get(directory) ?? [];
      sessionIDs.push(current.session.id);
      sessionIDsByDirectory.set(directory, sessionIDs);
    }
    if (current === node && isExpanded) return;
    for (const child of current.children) visit(child);
  };
  visit(node);
  return [...sessionIDsByDirectory].map(([directory, sessionIDs]) => ({ directory, sessionIDs }));
};

export const selectFolderRootNodes = (
  sessionIds: string[],
  nodeBySessionId: ReadonlyMap<string, SessionNode>,
): SessionNode[] => {
  const assignedSessionIds = new Set(sessionIds);

  return sessionIds
    .map((sessionId) => nodeBySessionId.get(sessionId))
    .filter((node): node is SessionNode => {
      if (!node) return false;

      const visited = new Set<string>();
      // SAFETY: upstream session records may carry the optional parentID field
      // even though the generated SDK Session type does not declare it.
      let parentID = (node.session as SessionNode['session'] & { parentID?: string | null }).parentID ?? null;
      while (parentID && !visited.has(parentID)) {
        if (assignedSessionIds.has(parentID) && nodeBySessionId.has(parentID)) return false;
        visited.add(parentID);
        const parentNode = nodeBySessionId.get(parentID);
        // SAFETY: the same upstream optional parentID field is read only after
        // the parent node has been resolved from the typed session map.
        parentID = (parentNode?.session as (SessionNode['session'] & { parentID?: string | null }) | undefined)?.parentID ?? null;
      }
      return true;
  });
};

type FolderHierarchyEntry = {
  id: string;
  parentId?: string | null;
  scopeKey?: string | null;
};

const getFolderHierarchyKey = (folder: FolderHierarchyEntry): string => (
  folder.scopeKey ? getSessionFolderIdentityKey(folder.scopeKey, folder.id) : folder.id
);

const getFolderParentKey = (folder: FolderHierarchyEntry): string | null => {
  if (!folder.parentId) return null;
  return folder.scopeKey
    ? getSessionFolderIdentityKey(folder.scopeKey, folder.parentId)
    : folder.parentId;
};

/**
 * Preserve stored folder order while projecting every disconnected or cyclic
 * component from a deterministic root. The persisted parent links stay as-is.
 */
export const normalizeFolderRoots = <T extends FolderHierarchyEntry>(folders: readonly T[]): T[] => {
  const folderByKey = new Map(folders.map((folder) => [getFolderHierarchyKey(folder), folder]));
  const childrenByParentId = new Map<string, T[]>();
  for (const folder of folders) {
    const parentKey = getFolderParentKey(folder);
    if (!parentKey || !folderByKey.has(parentKey)) continue;
    const children = childrenByParentId.get(parentKey) ?? [];
    children.push(folder);
    childrenByParentId.set(parentKey, children);
  }

  const visited = new Set<string>();
  const roots: T[] = [];
  const addRoot = (folder: T): void => {
    const folderKey = getFolderHierarchyKey(folder);
    if (visited.has(folderKey)) return;
    roots.push(folder);
    const stack = [folder];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const currentKey = getFolderHierarchyKey(current);
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);
      for (const child of childrenByParentId.get(currentKey) ?? []) stack.push(child);
    }
  };

  folders.forEach((folder) => {
    const parentKey = getFolderParentKey(folder);
    if (!parentKey || !folderByKey.has(parentKey)) addRoot(folder);
  });
  folders.forEach(addRoot);
  return roots;
};

type FolderProjectionEntry = FolderHierarchyEntry & {
  name: string;
  nodeCount: number;
};

type FolderProjectionOptions = {
  archivedBucket: boolean;
  searchQuery: string;
};

export const selectFolderIdsForProjection = (
  entries: readonly FolderProjectionEntry[],
  options: FolderProjectionOptions,
): Set<string> => {
  const isIdQuery = options.searchQuery.trim().toLowerCase().startsWith('ses_');
  const entryByKey = new Map(entries.map((entry) => [getFolderHierarchyKey(entry), entry]));
  const childIdsByParentId = new Map<string, string[]>();
  const malformedIds = new Set<string>();
  for (const entry of entries) {
    const entryKey = getFolderHierarchyKey(entry);
    const parentKey = getFolderParentKey(entry);
    if (parentKey && !entryByKey.has(parentKey)) {
      malformedIds.add(entryKey);
      continue;
    }
    if (parentKey) {
      const children = childIdsByParentId.get(parentKey) ?? [];
      children.push(entryKey);
      childIdsByParentId.set(parentKey, children);
    }

    const visitedParents = new Set<string>();
    let currentKey: string | null = entryKey;
    while (currentKey) {
      if (visitedParents.has(currentKey)) {
        malformedIds.add(entryKey);
        break;
      }
      visitedParents.add(currentKey);
      currentKey = getFolderParentKey(entryByKey.get(currentKey) ?? entry);
    }
  }

  const keptIds = new Set<string>();
  const visitingIds = new Set<string>();
  const shouldKeep = (folderKey: string): boolean => {
    if (keptIds.has(folderKey)) return true;
    if (visitingIds.has(folderKey)) return false;

    const entry = entryByKey.get(folderKey);
    if (!entry) return false;
    visitingIds.add(folderKey);

    let keep = malformedIds.has(folderKey);
    if (!keep && !options.searchQuery) keep = true;
    if (!keep && !isIdQuery && matchesRankQuery([entry.name], options.searchQuery)) keep = true;
    if (!keep && options.archivedBucket && entry.nodeCount === 0) {
      // Preserve the archived empty-folder rule for non-matching folders:
      // search does not expose them unless a descendant has archived content.
      // A matching folder name is an explicit result and is kept above.
      keep = (childIdsByParentId.get(folderKey) ?? []).some(shouldKeep);
    } else {
      if (!keep && entry.nodeCount > 0) keep = true;
      if (!keep) keep = (childIdsByParentId.get(folderKey) ?? []).some(shouldKeep);
    }

    visitingIds.delete(folderKey);
    if (keep) keptIds.add(folderKey);
    return keep;
  };

  entries.forEach((entry) => shouldKeep(getFolderHierarchyKey(entry)));
  return new Set(entries
    .map((entry) => getFolderHierarchyKey(entry))
    .filter((folderKey) => keptIds.has(folderKey)));
};

/** Row count at which a large archived session group switches to virtualization. */
const SESSION_GROUP_VIRTUALIZE_THRESHOLD = 50;

type SessionGroupVirtualizationMode = 'none' | 'roots';

/**
 * Pick the group's virtualization mode at the shared row threshold. Archived
 * buckets virtualize whole root subtrees; all other groups stay in normal flow.
 */
export const selectSessionGroupVirtualizationMode = (input: {
  isArchivedBucket: boolean;
  rootCount: number;
  threshold?: number;
}): SessionGroupVirtualizationMode => {
  const threshold = input.threshold ?? SESSION_GROUP_VIRTUALIZE_THRESHOLD;
  if (input.isArchivedBucket && input.rootCount >= threshold) return 'roots';
  return 'none';
};

/**
 * The scroll element a group virtualizer should use: the locally resolved one
 * wins once set (it may come from the ancestor walk when no ref is threaded),
 * otherwise the element threaded in by the scroller. Readiness can therefore
 * be true on the same commit that turns virtualization on whenever the parent
 * has already mounted its scroller, instead of waiting a commit for the
 * layout-effect state update.
 */
export const selectSessionGroupScrollElement = <T>(input: {
  providedScrollElement: T | null;
  resolvedScrollElement: T | null;
}): T | null => input.resolvedScrollElement ?? input.providedScrollElement;

const sessionObjectVersions = new WeakMap<Session, number>();
let nextSessionObjectVersion = 1;

const getSessionObjectVersion = (session: Session): number => {
  const existing = sessionObjectVersions.get(session);
  if (existing !== undefined) return existing;
  const version = nextSessionObjectVersion;
  nextSessionObjectVersion += 1;
  sessionObjectVersions.set(session, version);
  return version;
};

/**
 * Build a key encoding descendant IDs and session object versions. This lets
 * row memoization detect one changed descendant without recursively comparing
 * every subtree after a reference-only grouping rebuild.
 */
export const computeNodeStructureKey = (node: SessionNode): string => {
  if (node.children.length === 0) {
    return '';
  }

  const childKeys = node.children.map((child) => {
    const childVersion = getSessionObjectVersion(child.session);
    if (child.children.length === 0) {
      return `${child.session.id}@${childVersion}`;
    }
    return `${child.session.id}@${childVersion}:${computeNodeStructureKey(child)}`;
  });

  return childKeys.join('|');
};

export const nodeHasPinnedMembershipChange = (
  prevNode: SessionNode,
  nextNode: SessionNode,
  prevPinnedSessionIds: Set<string>,
  nextPinnedSessionIds: Set<string>,
  prevGroupDirectory?: string | null,
  nextGroupDirectory?: string | null,
): boolean => {
  const runtimeKey = getRuntimeKey();
  const visit = (previous: SessionNode, current: SessionNode): boolean => {
    if (previous.session.id !== current.session.id || previous.children.length !== current.children.length) {
      return true;
    }

    // SAFETY: sidebar fixtures and upstream payloads may omit directory even
    // though the generated Session type marks it as required.
    const prevDirectory = (previous.session as SessionNode['session'] & { directory?: string | null }).directory
      ?? prevGroupDirectory;
    // SAFETY: mirror the same defensive directory read for the next snapshot.
    const nextDirectory = (current.session as SessionNode['session'] & { directory?: string | null }).directory
      ?? nextGroupDirectory;
    const prevKey = getPinnedSessionKey(runtimeKey, prevDirectory ?? '', previous.session.id);
    const nextKey = getPinnedSessionKey(runtimeKey, nextDirectory ?? '', current.session.id);
    if (
      (prevKey ? prevPinnedSessionIds.has(prevKey) : false)
      !== (nextKey ? nextPinnedSessionIds.has(nextKey) : false)
    ) {
      return true;
    }

    return previous.children.some((child, index) => visit(child, current.children[index]));
  };

  return visit(prevNode, nextNode);
};

/**
 * Visibility classes for the row's right-edge badges (pending permissions /
 * questions). The hover actions paint over the row's right edge, and they are
 * also forced visible while the row menu is open — without hover, so the
 * hover reveal padding does not apply and the actions would cover the badges.
 * The badges therefore yield exactly like the date/branch metadata label:
 * hidden while the actions are hover-revealed or the menu is open. Rows with
 * always-visible actions reserve permanent padding instead, so their badges
 * never conflict and must stay visible.
 */
export const selectRowBadgeVisibilityClass = (input: {
  actionsAlwaysVisible: boolean;
  menuOpen: boolean;
  hideOnHoverClass: string;
}): string => {
  if (input.actionsAlwaysVisible) return '';
  return `transition-opacity duration-150 ${input.menuOpen ? 'opacity-0' : input.hideOnHoverClass}`;
};

/**
 * Resolve the session id whose sidebar menu is open, or null if no
 * menu is open. Only one row can have its menu open at a time.
 */
export const resolveMenuOpenSessionId = (
  nodes: SessionNode[],
  menuKey: string | null,
  renderContext: 'project' | 'recent',
  archivedBucket: boolean,
): string | null => {
  if (!menuKey) return null;
  const bucketTag = archivedBucket ? 'archived' : 'active';
  let result: string | null = null;
  const visit = (node: SessionNode): boolean => {
    const nodeMenuKey = `${renderContext}:${bucketTag}:${node.session.id}`;
    if (nodeMenuKey === menuKey) {
      result = node.session.id;
      return true;
    }
    for (const child of node.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  nodes.forEach((node) => visit(node));
  return result;
};
