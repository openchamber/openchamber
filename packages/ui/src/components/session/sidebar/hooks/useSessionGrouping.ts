import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionGroup, SessionNode } from '../types';
import {
  compareSessionsByPinnedAndTime,
  dedupeSessionsById,
  getArchivedScopeKey,
  isPathWithinScope,
  normalizeForBranchComparison,
  normalizePath,
} from '../utils';
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  getCompatibleSessionArchivedAt,
  getCompatibleSessionDirectory,
  getCompatibleSessionParentId,
  getCompatibleSessionProjectWorktree,
} from '@/sync/compat';

type Args = {
  homeDirectory: string | null;
  worktreeMetadata: Map<string, WorktreeMetadata>;
  pinnedSessionIds: Set<string>;
  gitBranches: Map<string, string | null>;
  isVSCode: boolean;
};

const isArchivedSession = (session: Session): boolean => Boolean(getCompatibleSessionArchivedAt(session));

export const useSessionGrouping = (args: Args) => {
  const { t } = useI18n();
  const buildGroupSearchText = React.useCallback((group: SessionGroup): string => {
    return [group.label, group.branch ?? '', group.description ?? '', group.directory ?? ''].join(' ').toLowerCase();
  }, []);

  const buildSessionSearchText = React.useCallback((session: Session): string => {
    const sessionDirectory = normalizePath(getCompatibleSessionDirectory(session)) ?? '';
    const sessionTitle = (session.title || t('sessions.sidebar.session.untitled')).trim();
    return `${sessionTitle} ${sessionDirectory}`.toLowerCase();
  }, [t]);

  const filterSessionNodesForSearch = React.useCallback(
    (nodes: SessionNode[], query: string): SessionNode[] => {
      if (!query) {
        return nodes;
      }

      return nodes.flatMap((node) => {
        const nodeMatches = buildSessionSearchText(node.session).includes(query);
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
      const sortedProjectSessions = dedupeSessionsById(projectSessions)
        .sort((a, b) => compareSessionsByPinnedAndTime(a, b, args.pinnedSessionIds));

      const sessionMap = new Map(sortedProjectSessions.map((session) => [session.id, session]));
      const childrenMap = new Map<string, Session[]>();
      sortedProjectSessions.forEach((session) => {
        const parentID = getCompatibleSessionParentId(session);
        if (!parentID) return;
        const parentSession = sessionMap.get(parentID);
        if (!parentSession || isArchivedSession(parentSession) !== isArchivedSession(session)) {
          return;
        }
        const collection = childrenMap.get(parentID) ?? [];
        collection.push(session);
        childrenMap.set(parentID, collection);
      });
      childrenMap.forEach((list) => list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, args.pinnedSessionIds)));

      const worktreeByPath = new Map<string, WorktreeMetadata>();
      availableWorktrees.forEach((meta) => {
        if (meta.path) {
          const normalized = normalizePath(meta.path) ?? meta.path;
          worktreeByPath.set(normalized, meta);
        }
      });
      const normalizedWorktreePaths = [...worktreeByPath.keys()];

      const getSessionWorktree = (session: Session): WorktreeMetadata | null => {
        const sessionDirectory = normalizePath(getCompatibleSessionDirectory(session));
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

      const buildProjectNode = (session: Session): SessionNode => {
        const children = childrenMap.get(session.id) ?? [];
        return { session, children: children.map((child) => buildProjectNode(child)), worktree: getSessionWorktree(session) };
      };

      const roots = sortedProjectSessions.filter((session) => {
        const parentID = getCompatibleSessionParentId(session);
        if (!parentID) return true;
        const parentSession = sessionMap.get(parentID);
        if (!parentSession) return true;
        return isArchivedSession(parentSession) !== isArchivedSession(session);
      });

      const groupedNodes = new Map<string, SessionNode[]>();
      const archivedKey = '__archived__';

      const getGroupKey = (session: Session) => {
        if (getCompatibleSessionArchivedAt(session)) return archivedKey;
        const metadataPath = normalizePath(args.worktreeMetadata.get(session.id)?.path ?? null);
        const sessionDirectory = normalizePath(getCompatibleSessionDirectory(session));
        if (!metadataPath && !sessionDirectory) return archivedKey;
        const fallbackDirectory = normalizePath(getCompatibleSessionProjectWorktree(session));
        const normalizedDir = metadataPath ?? sessionDirectory ?? fallbackDirectory;
        if (!normalizedDir) return archivedKey;

        const matchingWorktree = normalizedDir !== normalizedProjectRoot
          ? normalizedWorktreePaths.find((worktreePath) => isPathWithinScope(normalizedDir, worktreePath))
          : null;
        if (matchingWorktree) return matchingWorktree;
        if (isPathWithinScope(normalizedDir, normalizedProjectRoot)) return normalizedProjectRoot ?? '__project_root__';
        return archivedKey;
      };

      roots.forEach((session) => {
        const node = buildProjectNode(session);
        const groupKey = getGroupKey(session);
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

      // Calculate activity info for each worktree to determine sorting priority
      const worktreeActivityInfo = new Map<string, { hasActiveSession: boolean; lastUpdatedAt: number }>();
      availableWorktrees.forEach((meta) => {
        const directory = normalizePath(meta.path) ?? meta.path;
        const sessionsInWorktree = groupedNodes.get(directory) ?? [];
        const hasActiveSession = sessionsInWorktree.length > 0;
        // Calculate the latest update time among all sessions in this worktree
        const lastUpdatedAt = sessionsInWorktree.reduce((max, node) => {
          const updatedAt = Number(node.session.time?.updated ?? node.session.time?.created ?? 0);
          if (!Number.isFinite(updatedAt)) {
            return max;
          }
          return Math.max(max, updatedAt);
        }, 0);

        worktreeActivityInfo.set(directory, { hasActiveSession, lastUpdatedAt });
      });

      // Sort worktrees: active first (by last updated desc), then inactive (by label asc)
      const sortedWorktrees = [...availableWorktrees].sort((a, b) => {
        const aDir = normalizePath(a.path) ?? a.path;
        const bDir = normalizePath(b.path) ?? b.path;
        const aInfo = worktreeActivityInfo.get(aDir) ?? { hasActiveSession: false, lastUpdatedAt: 0 };
        const bInfo = worktreeActivityInfo.get(bDir) ?? { hasActiveSession: false, lastUpdatedAt: 0 };

        // First priority: active status (active first)
        if (aInfo.hasActiveSession !== bInfo.hasActiveSession) {
          return aInfo.hasActiveSession ? -1 : 1;
        }

        // Second priority: for active worktrees, sort by last updated (desc)
        if (aInfo.hasActiveSession && bInfo.hasActiveSession) {
          return bInfo.lastUpdatedAt - aInfo.lastUpdatedAt;
        }

        // Third priority: for inactive worktrees, sort by label (asc)
        const aLabel = (a.label || a.branch || a.name || a.path || '').toLowerCase();
        const bLabel = (b.label || b.branch || b.name || b.path || '').toLowerCase();
        return aLabel.localeCompare(bLabel);
      });

      sortedWorktrees.forEach((meta) => {
        const directory = normalizePath(meta.path) ?? meta.path;
        const currentBranch = args.gitBranches.get(directory)?.trim() || null;
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
    [args.homeDirectory, args.worktreeMetadata, args.pinnedSessionIds, args.gitBranches, args.isVSCode, t],
  );

  return {
    buildGroupSearchText,
    buildSessionSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  };
};
