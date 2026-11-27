import type { SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { matchesRankQuery, SIDEBAR_SEARCH } from '@/lib/search/fuzzySearch';
import { normalizePath } from '@/lib/pathNormalization';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { getPinnedSessionKey } from '@/lib/sessionPins';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionNode } from '../types';
import { listedChildren } from '../listedChildren';

export type SessionNodeChildRenderExtras = {
  subtreeContainsEditing: Set<string>;
  menuOpenSessionId: string | null;
  nodeStructureKey: string;
  blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
  relativeTimeTick?: number;
};

export type SessionNodeRenderExtras<TNode = SessionNode> = SessionNodeChildRenderExtras & {
  childRenderExtrasFor?: (child: TNode) => SessionNodeChildRenderExtras;
};

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

export type BlockingBadgeSessionScope = {
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

const collectRowBadgeNodes = (
  node: SessionNode,
  isExpanded: boolean,
  showSubagentSessions = true,
): SessionNode[] => {
  const ownRows = new Set(isExpanded ? listedChildren(node, showSubagentSessions) : []);
  const out: SessionNode[] = [node];
  const visit = (current: SessionNode): void => {
    out.push(current);
    current.children.forEach(visit);
  };
  node.children.forEach((child) => {
    if (!ownRows.has(child)) visit(child);
  });
  return out;
};

type BlockingBadgeSession = {
  sessionID: string;
  directory: string;
};

export const selectBlockingBadgeSessions = (
  node: SessionNode,
  isExpanded: boolean,
  fallbackDirectory: string | null,
  showSubagentSessions = true,
): BlockingBadgeSession[] => collectRowBadgeNodes(node, isExpanded, showSubagentSessions).flatMap((current) => {
  const directory = resolveGlobalSessionDirectory(current.session)
    ?? normalizePath(current.worktree?.path)
    ?? fallbackDirectory;
  return directory ? [{ sessionID: current.session.id, directory }] : [];
});

export const selectBlockingBadgeSessionScopes = (
  node: SessionNode,
  isExpanded: boolean,
  fallbackDirectory: string | null,
  showSubagentSessions = true,
): BlockingBadgeSessionScope[] => {
  const sessionIDsByDirectory = new Map<string, string[]>();
  for (const { sessionID, directory } of selectBlockingBadgeSessions(node, isExpanded, fallbackDirectory, showSubagentSessions)) {
    const sessionIDs = sessionIDsByDirectory.get(directory) ?? [];
    sessionIDs.push(sessionID);
    sessionIDsByDirectory.set(directory, sessionIDs);
  }
  return [...sessionIDsByDirectory].map(([directory, sessionIDs]) => ({ directory, sessionIDs }));
};

export const collectHiddenRowSessionIds = (
  node: SessionNode,
  isExpanded: boolean,
  showSubagentSessions = true,
): ReadonlySet<string> => new Set(
  collectRowBadgeNodes(node, isExpanded, showSubagentSessions).slice(1).map((current) => current.session.id),
);

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

type FolderHierarchyEntry = {
  id: string;
  parentId?: string | null;
};

export const normalizeFolderRoots = <T extends FolderHierarchyEntry>(folders: readonly T[]): T[] => {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const childrenByParentId = new Map<string, T[]>();
  for (const folder of folders) {
    if (!folder.parentId || !folderById.has(folder.parentId)) continue;
    const children = childrenByParentId.get(folder.parentId) ?? [];
    children.push(folder);
    childrenByParentId.set(folder.parentId, children);
  }

  const visited = new Set<string>();
  const roots: T[] = [];
  const addRoot = (folder: T): void => {
    if (visited.has(folder.id)) return;
    roots.push(folder);
    const stack = [folder.id];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      for (const child of childrenByParentId.get(id) ?? []) stack.push(child.id);
    }
  };

  folders.forEach((folder) => {
    if (!folder.parentId || !folderById.has(folder.parentId)) addRoot(folder);
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
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const childIdsByParentId = new Map<string, string[]>();
  const malformedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.parentId && !entryById.has(entry.parentId)) {
      malformedIds.add(entry.id);
      continue;
    }
    if (entry.parentId) {
      const children = childIdsByParentId.get(entry.parentId) ?? [];
      children.push(entry.id);
      childIdsByParentId.set(entry.parentId, children);
    }

    const visitedParents = new Set<string>();
    let currentId: string | null | undefined = entry.id;
    while (currentId) {
      if (visitedParents.has(currentId)) {
        malformedIds.add(entry.id);
        break;
      }
      visitedParents.add(currentId);
      currentId = entryById.get(currentId)?.parentId;
    }
  }

  const keptIds = new Set<string>();
  const visitingIds = new Set<string>();
  const shouldKeep = (folderId: string): boolean => {
    if (keptIds.has(folderId)) return true;
    if (visitingIds.has(folderId)) return false;

    const entry = entryById.get(folderId);
    if (!entry) return false;
    visitingIds.add(folderId);

    let keep = malformedIds.has(folderId);
    if (!keep && options.archivedBucket && entry.nodeCount === 0) {
      keep = (childIdsByParentId.get(folderId) ?? []).some(shouldKeep);
    } else {
      if (!keep && !options.searchQuery) keep = true;
      if (!keep && (entry.nodeCount > 0 || (!isIdQuery && matchesRankQuery([entry.name], options.searchQuery, SIDEBAR_SEARCH)))) keep = true;
      if (!keep) keep = (childIdsByParentId.get(folderId) ?? []).some(shouldKeep);
    }

    visitingIds.delete(folderId);
    if (keep) keptIds.add(folderId);
    return keep;
  };

  entries.forEach((entry) => shouldKeep(entry.id));
  return new Set(entries.filter((entry) => keptIds.has(entry.id)).map((entry) => entry.id));
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

export const resolveTooltipBranchLabel = (
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null } | null | undefined,
  worktreeBranch: string | null | undefined,
): string | null => (
  secondaryMeta
    ? (secondaryMeta.branchLabel ?? null)
    : (worktreeBranch ?? null)
);

export const resolveSessionPrLookup = (
  worktree: WorktreeMetadata | null | undefined,
  isVSCode: boolean,
): { directory: string; branch: string } | null => {
  if (isVSCode) return null;
  const branch = worktree?.branch?.trim();
  const directory = normalizePath(worktree?.path ?? null);
  return branch && directory ? { directory, branch } : null;
};

export const resolveMenuOpenSessionId = (
  nodes: SessionNode[],
  menuKey: string | null,
  renderContext: SessionSidebarRenderContext,
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

export const collectNodeDescendantIds = (root: SessionNode): string[] => {
  const out: string[] = [];
  const walk = (n: SessionNode) => {
    n.children.forEach((child) => {
      out.push(child.session.id);
      walk(child);
    });
  };
  walk(root);
  return out;
};

export const collectNodeDescendantSessions = (root: SessionNode): Session[] => {
  const out: Session[] = [];
  const walk = (current: SessionNode) => {
    current.children.forEach((child) => {
      out.push(child.session);
      walk(child);
    });
  };
  walk(root);
  return out;
};
