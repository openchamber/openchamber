import type { Session } from '@opencode-ai/sdk/v2/client';

import { orderSessionsByLifecycleScopes } from '@/sync/session-ordering';
import type { WorktreeMetadata } from '@/types/worktree';

import { getProjectLabel, normalizePath } from './mobilePaths';

export type ProjectMeta = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
  isGitRepo: boolean;
  worktrees: WorktreeMetadata[];
  /** Read by the 'date-added' / 'recent' project orders. */
  addedAt?: number;
  lastOpenedAt?: number;
};

export type WorktreeBucket = {
  /** Stable key — usually the worktree path (or project root). */
  key: string;
  /** Display label — branch name when available, else folder name. */
  label: string;
  /** Filesystem path used as `directory` for new sessions started here. */
  path: string;
  /** Underlying worktree metadata, null when this bucket represents the project root. */
  worktree: WorktreeMetadata | null;
  /** Sessions matched into this bucket, sorted by recency desc. */
  sessions: Session[];
};

export type ProjectNode = {
  project: ProjectMeta;
  buckets: WorktreeBucket[];
  totalSessions: number;
  isActive: boolean;
};

export const getSessionParentId = (session: Session): string | null => (
  // SAFETY: OpenCode session payloads may include the optional parentID field even when the SDK type omits it.
  (session as Session & { parentID?: string | null }).parentID ?? null
);

export const getSessionDirectory = (session: Session): string => {
  // SAFETY: OpenCode session payloads may carry directory/worktree on fields the SDK base type omits.
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};

export const findExactWorktreeMatch = (project: ProjectMeta, normalizedDirectory: string): WorktreeMetadata | null => (
  project.worktrees.find((worktree) => normalizePath(worktree.path) === normalizedDirectory) ?? null
);

const projectMatchesExactDirectory = (project: ProjectMeta, normalizedDirectory: string): boolean => (
  normalizedDirectory === project.path || Boolean(findExactWorktreeMatch(project, normalizedDirectory))
);

export const findExactProjectMatch = (projects: ProjectMeta[], directory: string): ProjectMeta | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory) return null;
  return projects.find((project) => projectMatchesExactDirectory(project, normalizedDirectory)) ?? null;
};

/**
 * Top-level sessions the user pinned. Only roots are lifted into the global
 * Pinned section: a pinned child stays where its parent tree renders it.
 */
export const selectPinnedRootSessionIds = (
  sessions: readonly Session[],
  isPinned: (session: Session) => boolean,
): Set<string> => {
  const rootIds = new Set<string>();
  for (const session of sessions) {
    if (!getSessionParentId(session) && isPinned(session)) {
      rootIds.add(session.id);
    }
  }
  return rootIds;
};

/**
 * Return every session in the supplied roots' in-snapshot subtrees.
 *
 * The parent index is built once for all roots, and the visited set makes the
 * traversal safe when malformed snapshots contain parent cycles.
 */
export const collectSessionSubtreeIds = (
  sessions: readonly Session[],
  rootIds: ReadonlySet<string>,
): Set<string> => {
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    const parentId = getSessionParentId(session);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId);
    if (children) {
      children.push(session.id);
    } else {
      childrenByParent.set(parentId, [session.id]);
    }
  }

  const subtreeIds = new Set<string>();
  const pending = [...rootIds];
  for (let index = 0; index < pending.length; index += 1) {
    const sessionId = pending[index];
    if (subtreeIds.has(sessionId)) continue;
    subtreeIds.add(sessionId);
    pending.push(...(childrenByParent.get(sessionId) ?? []));
  }
  return subtreeIds;
};

type MobilePinnedOwnership = {
  /** Pinned top-level sessions; the Pinned section's direct rows. */
  rootIds: ReadonlySet<string>;
  /** Every session under a pinned root in the current snapshot (root included). */
  subtreeIds: ReadonlySet<string>;
};

const EMPTY_PINNED_OWNERSHIP: MobilePinnedOwnership = {
  rootIds: new Set<string>(),
  subtreeIds: new Set<string>(),
};

/**
 * Drawer-only pinned ownership. The phone drawer's global Pinned section owns
 * each pinned root plus its in-snapshot subtree, so the project tree and the
 * managed Chats bucket skip those ids. The iPad sidebar variant has no global
 * Pinned section and keeps its existing grouped tree, so it always receives
 * the empty scope.
 */
export const resolveMobilePinnedOwnership = (
  sessions: readonly Session[],
  isPinned: (session: Session) => boolean,
  enabled: boolean,
): MobilePinnedOwnership => {
  if (!enabled) return EMPTY_PINNED_OWNERSHIP;
  const rootIds = selectPinnedRootSessionIds(sessions, isPinned);
  if (rootIds.size === 0) return EMPTY_PINNED_OWNERSHIP;
  return { rootIds, subtreeIds: collectSessionSubtreeIds(sessions, rootIds) };
};

/**
 * The Pinned section's render order: pinned roots and their complete
 * in-snapshot subtrees, run through the shared lifecycle comparator so a
 * pinned root never sinks behind recency and its children stay attached.
 */
export const orderPinnedSessionSubtree = (
  sessions: readonly Session[],
  subtreeIds: ReadonlySet<string>,
  pinnedSessionIds: Set<string>,
  sessionOrderRanks: ReadonlyMap<string, number>,
): Session[] => {
  if (subtreeIds.size === 0) return [];
  return orderSessionsByLifecycleScopes(
    sessions.filter((session) => subtreeIds.has(session.id)),
    pinnedSessionIds,
    sessionOrderRanks,
  );
};

type BuildMobileProjectNodesArgs = {
  projects: ProjectMeta[];
  activeProjectId: string | null;
  sessions: readonly Session[];
  /** Session ids owned by the drawer's global Pinned section. */
  pinnedSubtreeIds: ReadonlySet<string>;
  /** True in the phone drawer (which renders the Pinned section). */
  hidePinnedSessions: boolean;
  pinnedSessionIds: Set<string>;
  sessionOrderRanks: ReadonlyMap<string, number>;
};

/**
 * Match sessions into their project/worktree buckets, order every bucket, and
 * count each project's root sessions. A pinned root is counted here even
 * though `hidePinnedSessions` keeps its subtree out of the bucket: totals
 * describe the project, and the Pinned section only changes where those rows
 * render.
 */
export const buildMobileProjectNodes = ({
  projects,
  activeProjectId,
  sessions,
  pinnedSubtreeIds,
  hidePinnedSessions,
  pinnedSessionIds,
  sessionOrderRanks,
}: BuildMobileProjectNodesArgs): ProjectNode[] => {
  const nodes: ProjectNode[] = projects.map((project) => ({
    project,
    buckets: [],
    totalSessions: 0,
    isActive: project.id === activeProjectId,
  }));

  const ensureBucket = (node: ProjectNode, path: string, worktree: WorktreeMetadata | null): WorktreeBucket => {
    const normalizedBucketPath = normalizePath(path) || node.project.path;
    const key = normalizedBucketPath || '__root__';
    let bucket = node.buckets.find((entry) => entry.key === key);
    if (!bucket) {
      bucket = {
        key,
        label: worktree?.branch || getProjectLabel(normalizedBucketPath),
        path: normalizedBucketPath,
        worktree,
        sessions: [],
      };
      node.buckets.push(bucket);
    }
    return bucket;
  };

  for (const node of nodes) {
    ensureBucket(node, node.project.path, null);
    for (const worktree of node.project.worktrees) ensureBucket(node, worktree.path, worktree);
  }

  for (const session of sessions) {
    const directory = getSessionDirectory(session);
    if (!directory) continue;
    const normalizedDirectory = normalizePath(directory);
    const node = nodes.find((entry) => projectMatchesExactDirectory(entry.project, normalizedDirectory));
    if (!node) continue;
    if (!getSessionParentId(session)) node.totalSessions += 1;
    // A pinned root and its complete in-snapshot subtree render through the
    // global Pinned section; do not duplicate any of them in the project tree.
    if (hidePinnedSessions && pinnedSubtreeIds.has(session.id)) continue;
    const matchedWorktree = findExactWorktreeMatch(node.project, normalizedDirectory);
    const bucket = matchedWorktree
      ? ensureBucket(node, matchedWorktree.path, matchedWorktree)
      : ensureBucket(node, node.project.path, null);
    bucket.sessions.push(session);
  }

  for (const node of nodes) {
    for (const bucket of node.buckets) {
      bucket.sessions = orderSessionsByLifecycleScopes(bucket.sessions, pinnedSessionIds, sessionOrderRanks);
    }
  }

  return nodes;
};
