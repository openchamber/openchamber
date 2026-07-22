import { getRuntimeKey } from '@/lib/runtime-switch';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import type { SessionNode } from './types';

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
      let parentID = (node.session as SessionNode['session'] & { parentID?: string | null }).parentID ?? null;
      while (parentID && !visited.has(parentID)) {
        if (assignedSessionIds.has(parentID) && nodeBySessionId.has(parentID)) return false;
        visited.add(parentID);
        const parentNode = nodeBySessionId.get(parentID);
        parentID = (parentNode?.session as (SessionNode['session'] & { parentID?: string | null }) | undefined)?.parentID ?? null;
      }
      return true;
    });
};

const sessionObjectVersions = new WeakMap<object, number>();
let nextSessionObjectVersion = 1;

const getSessionObjectVersion = (session: object): number => {
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

    const prevDirectory = (previous.session as SessionNode['session'] & { directory?: string | null }).directory
      ?? prevGroupDirectory;
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
