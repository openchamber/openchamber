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
  subtreeContainsActive: Set<string>;
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
 * `currentSessionId` or `editingId` changes. With M visible rows, this
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

/**
 * Build a structural key for `node` that encodes the IDs of all
 * descendants. Used by `SessionNodeItem.areEqual` so a reference-only
 * rebuild of the tree (which happens on every `buildGroupedSessions`
 * pass) can be detected with a single string compare instead of a
 * recursive walk per row.
 */
export const computeNodeStructureKey = (node: SessionNode): string => {
  if (node.children.length === 0) {
    return '';
  }

  const childKeys = node.children.map((child) => {
    if (child.children.length === 0) {
      return child.session.id;
    }
    return `${child.session.id}:${computeNodeStructureKey(child)}`;
  });

  return childKeys.join('|');
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

/**
 * Right padding reserved on the row button so the absolute hover/focus action
 * icons (quick-archive, open-in-editor, menu — anchored `right-0`) don't overlap
 * the row's in-flow content.
 *
 * Minimal non-VS Code rows normally reserve only `pr-2`: the inline date/goal
 * label fades out on hover, so the actions take its place and the title barely
 * shifts. A pending-permission badge, however, stays opaque at the row's right
 * edge, so `pr-2` lets the actions overlap it (#2284). When the badge is present,
 * reserve the room the VS Code minimal two-action layout already uses (`pr-14`)
 * so the title shrinks and the badge shifts clear of the icons.
 */
export const resolveRevealPaddingClass = ({
  isMinimalMode,
  isVSCode,
  showQuickArchiveAction,
  showOpenInEditorAction,
  hasPendingPermissionBadge,
}: {
  isMinimalMode: boolean;
  isVSCode: boolean;
  showQuickArchiveAction: boolean;
  showOpenInEditorAction: boolean;
  hasPendingPermissionBadge: boolean;
}): string => {
  if (isMinimalMode) {
    // VS Code minimal rows reveal up to three actions (open-in-editor +
    // quick-archive + menu, each h-4); open-in-editor is always present there.
    if (isVSCode) {
      if (showQuickArchiveAction && showOpenInEditorAction) return 'group-hover:pr-18';
      if (showQuickArchiveAction || showOpenInEditorAction) return 'group-hover:pr-14';
      return 'group-hover:pr-8';
    }
    if (hasPendingPermissionBadge) return 'group-hover:pr-14 group-focus-within:pr-14';
    return 'group-hover:pr-2 group-focus-within:pr-2';
  }
  if (isVSCode) {
    if (showQuickArchiveAction && showOpenInEditorAction) return 'group-hover:pr-18';
    if (showQuickArchiveAction || showOpenInEditorAction) return 'group-hover:pr-12';
    return 'group-hover:pr-5';
  }
  return showQuickArchiveAction
    ? 'group-hover:pr-12 group-focus-within:pr-12'
    : 'group-hover:pr-5 group-focus-within:pr-5';
};
