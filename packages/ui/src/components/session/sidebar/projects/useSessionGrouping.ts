import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionGroup, SessionNode } from '../types';
import {
  dedupeSessionsById,
  getArchivedScopeKey,
  normalizeForBranchComparison,
  normalizePath,
} from '../utils';
import { getSessionLifecycleOrderValue } from '@/sync/session-ordering';
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { getWorktreeFirstSeenAt } from './worktreeFirstSeen';

type Args = {
  homeDirectory: string | null;
  worktreeMetadata: Map<string, WorktreeMetadata>;
  pinnedSessionIds: Set<string>;
  sessionOrderRanks: ReadonlyMap<string, number>;
  gitBranches: Map<string, string | null>;
  isVSCode: boolean;
};

const isArchivedSession = (session: Session): boolean => Boolean(session.time?.archived);

export const useSessionGrouping = (args: Args) => {
  const { t } = useI18n();
  // Read at call time rather than captured: the branch map is rebuilt whenever
  // any directory's git status changes, and a builder that changed identity
  // with it would invalidate every project section in the sidebar. The section
  // cache compares the branches each project actually uses instead.
  const gitBranchesRef = React.useRef(args.gitBranches);
  gitBranchesRef.current = args.gitBranches;
  const buildGroupSearchText = React.useCallback((group: SessionGroup): string => {
    return [group.label, group.branch ?? '', group.description ?? '', group.directory ?? ''].join(' ').toLowerCase();
  }, []);

  const buildSessionSearchText = React.useCallback((session: Session): string => {
    const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null) ?? '';
    const sessionTitle = (session.title || t('sessions.sidebar.session.untitled')).trim();
    return `${sessionTitle} ${sessionDirectory}`.toLowerCase();
  }, [t]);

  const filterSessionNodesForSearch = React.useCallback(
    (nodes: SessionNode[], query: string): SessionNode[] => {
      if (!query) {
        return nodes;
      }

      return nodes.flatMap((node) => {
        const nodeMatches = matchesRankQuery([buildSessionSearchText(node.session)], query);
        if (nodeMatches) {
          return [node];
        }

        const filteredChildren = filterSessionNodesForSearch(node.children, query);
        if (filteredChildren.length === 0) {
          return [];
        }

        return [{ ...node, children: filteredChildren }];
      });
    },
    [buildSessionSearchText],
  );

  const buildGroupedSessions = React.useCallback(
    (
      projectSessions: Session[],
      projectRoot: string | null,
      availableWorktrees: WorktreeMetadata[],
      projectRootBranch: string | null,
      projectIsRepo: boolean,
    ) => {
      const normalizedProjectRoot = normalizePath(projectRoot ?? null);
      // `orderSessionsByLifecycleScopes` owns lifecycle ordering before project
      // ownership buckets are built. Dedupe retains that root/sibling order.
      const sortedProjectSessions = dedupeSessionsById(projectSessions);

      const sessionMap = new Map(sortedProjectSessions.map((session) => [session.id, session]));
      const childrenMap = new Map<string, Session[]>();
      sortedProjectSessions.forEach((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        if (!parentID) return;
        const parentSession = sessionMap.get(parentID);
        if (!parentSession || isArchivedSession(parentSession) !== isArchivedSession(session)) {
          return;
        }
        const collection = childrenMap.get(parentID) ?? [];
        collection.push(session);
        childrenMap.set(parentID, collection);
      });

      const worktreeByPath = new Map<string, WorktreeMetadata>();
      availableWorktrees.forEach((meta) => {
        if (meta.path) {
          const normalized = normalizePath(meta.path) ?? meta.path;
          worktreeByPath.set(normalized, meta);
        }
      });

      const getSessionWorktree = (session: Session): WorktreeMetadata | null => {
        const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
        const sessionWorktreeMeta = args.worktreeMetadata.get(session.id) ?? null;
        if (sessionWorktreeMeta) return sessionWorktreeMeta;
        if (sessionDirectory) {
          const worktree = worktreeByPath.get(sessionDirectory) ?? null;
          if (worktree && sessionDirectory !== normalizedProjectRoot) {
            return worktree;
          }
        }
        return null;
      };

      const claimedSessionIds = new Set<string>();
      const buildProjectNode = (session: Session): SessionNode => {
        claimedSessionIds.add(session.id);
        const children = childrenMap.get(session.id) ?? [];
        const childNodes: SessionNode[] = [];
        for (const child of children) {
          if (claimedSessionIds.has(child.id)) continue;
          childNodes.push(buildProjectNode(child));
        }
        return { session, children: childNodes, worktree: getSessionWorktree(session) };
      };

      const rootCandidates = sortedProjectSessions.filter((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        if (!parentID) return true;
        const parentSession = sessionMap.get(parentID);
        if (!parentSession) return true;
        return isArchivedSession(parentSession) !== isArchivedSession(session);
      });

      // A malformed cycle has no structural root. Start with normal roots,
      // then expose each still-unclaimed component from its first input row.
      const roots: SessionNode[] = [];
      const addRoot = (session: Session): void => {
        if (claimedSessionIds.has(session.id)) return;
        roots.push(buildProjectNode(session));
      };
      rootCandidates.forEach(addRoot);
      sortedProjectSessions.forEach(addRoot);

      const groupedNodes = new Map<string, SessionNode[]>();
      const archivedKey = '__archived__';

      const getGroupKey = (session: Session) => {
        if (session.time?.archived) return archivedKey;
        // VS Code groups by open workspace, not by worktree: every non-archived
        // session in a project belongs to that project's single (root) group.
        // Worktrees aren't registered in VS Code, so the desktop directory-match
        // below would otherwise dump these sessions into the archived bucket.
        if (args.isVSCode) return normalizedProjectRoot ?? '__project_root__';
        const metadataPath = normalizePath(args.worktreeMetadata.get(session.id)?.path ?? null);
        const normalizedDir = metadataPath ?? resolveGlobalSessionDirectory(session);
        if (!normalizedDir) return archivedKey;
        if (normalizedDir !== normalizedProjectRoot && worktreeByPath.has(normalizedDir)) return normalizedDir;
        if (normalizedDir === normalizedProjectRoot) return normalizedProjectRoot ?? '__project_root__';
        return archivedKey;
      };

      roots.forEach((node) => {
        const groupKey = getGroupKey(node.session);
        if (!groupedNodes.has(groupKey)) groupedNodes.set(groupKey, []);
        groupedNodes.get(groupKey)?.push(node);
      });

      const rootKey = normalizedProjectRoot ?? '__project_root__';
      const groups: SessionGroup[] = [{
        id: 'root',
        label: (projectIsRepo && projectRootBranch && projectRootBranch !== 'HEAD')
          ? t('sessions.sidebar.grouping.projectRootWithBranch', { branch: projectRootBranch })
          : t('sessions.sidebar.grouping.projectRoot'),
        branch: projectRootBranch ?? null,
        description: normalizedProjectRoot ? formatPathForDisplay(normalizedProjectRoot, args.homeDirectory) : null,
        isMain: true,
        isArchivedBucket: false,
        worktree: null,
        directory: normalizedProjectRoot,
        folderScopeKey: normalizedProjectRoot,
        sessions: groupedNodes.get(rootKey) ?? [],
      }];

      // Calculate display-order activity for each worktree.
      const worktreeActivityInfo = new Map<string, { hasActiveSession: boolean; lastUpdatedAt: number }>();
      availableWorktrees.forEach((meta) => {
        const directory = normalizePath(meta.path) ?? meta.path;
        const sessionsInWorktree = groupedNodes.get(directory) ?? [];
        const hasActiveSession = sessionsInWorktree.length > 0;
        // Lifecycle rank wins when present; timestamps seed bootstrap ordering.
        const lastUpdatedAt = sessionsInWorktree.reduce((max, node) => {
          const updatedAt = getSessionLifecycleOrderValue(node.session, args.sessionOrderRanks);
          if (!Number.isFinite(updatedAt)) {
            return max;
          }
          return Math.max(max, updatedAt);
        }, 0);

        worktreeActivityInfo.set(directory, { hasActiveSession, lastUpdatedAt });
      });

      // Sort populated worktrees by shared session activity, then empty ones by label.
      const sortedWorktrees = [...availableWorktrees].sort((a, b) => {
        const aDir = normalizePath(a.path) ?? a.path;
        const bDir = normalizePath(b.path) ?? b.path;
        const aInfo = worktreeActivityInfo.get(aDir) ?? { hasActiveSession: false, lastUpdatedAt: 0 };
        const bInfo = worktreeActivityInfo.get(bDir) ?? { hasActiveSession: false, lastUpdatedAt: 0 };

        // First priority: active status (active first)
        if (aInfo.hasActiveSession !== bInfo.hasActiveSession) {
          return aInfo.hasActiveSession ? -1 : 1;
        }

        // Second priority: for populated worktrees, sort by latest display activity.
        if (aInfo.hasActiveSession && bInfo.hasActiveSession) {
          return bInfo.lastUpdatedAt - aInfo.lastUpdatedAt;
        }

        // Third priority: for inactive worktrees, most recently discovered
        // first (a worktree created mid-session surfaces at the top of the
        // list; startup discovery ties and falls through to labels).
        const aSeen = getWorktreeFirstSeenAt(a.path);
        const bSeen = getWorktreeFirstSeenAt(b.path);
        if (aSeen !== bSeen) {
          return bSeen - aSeen;
        }

        // Fourth priority: sort by label (asc)
        const aLabel = (a.label || a.branch || a.name || a.path || '').toLowerCase();
        const bLabel = (b.label || b.branch || b.name || b.path || '').toLowerCase();
        return aLabel.localeCompare(bLabel);
      });

      // VS Code groups strictly by open workspace — no per-worktree subgroups.
      const worktreeGroups = args.isVSCode ? [] : sortedWorktrees;
      worktreeGroups.forEach((meta) => {
        const directory = normalizePath(meta.path) ?? meta.path;
        const currentBranch = gitBranchesRef.current.get(directory)?.trim() || null;
        const metadataBranch = meta.branch?.trim() || null;
        const shouldSyncLabelWithBranch = Boolean(
          currentBranch && metadataBranch && meta.label && normalizeForBranchComparison(meta.label) === normalizeForBranchComparison(metadataBranch),
        );
        const label = shouldSyncLabelWithBranch
          ? currentBranch!
          : (meta.label || meta.name || formatDirectoryName(directory, args.homeDirectory) || directory);

        groups.push({
          id: `worktree:${directory}`,
          label,
          branch: currentBranch || metadataBranch,
          description: formatPathForDisplay(directory, args.homeDirectory),
          isMain: false,
          isArchivedBucket: false,
          worktree: meta,
          directory,
          folderScopeKey: directory,
          sessions: groupedNodes.get(directory) ?? [],
        });
      });

      const archivedSessions = groupedNodes.get(archivedKey) ?? [];
      if (archivedSessions.length > 0) {
        groups.push({
          id: 'archived',
          label: t('sessions.sidebar.grouping.archived'),
          branch: null,
          description: t('sessions.sidebar.grouping.archivedDescription'),
          isMain: false,
          isArchivedBucket: true,
          worktree: null,
          directory: null,
          folderScopeKey: !args.isVSCode && normalizedProjectRoot ? getArchivedScopeKey(normalizedProjectRoot) : null,
          sessions: archivedSessions,
        });
      }

      return groups;
    },
    [args.homeDirectory, args.worktreeMetadata, args.sessionOrderRanks, args.isVSCode, t],
  );

  return {
    buildGroupSearchText,
    buildSessionSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  };
};
