import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroup, SessionNode, GroupSearchData } from '../types';
import { dedupeSessionsById, normalizePath } from '../utils';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';

type ProjectItem = {
  id: string;
  path: string;
  label?: string;
  normalizedPath: string;
  icon?: string;
  color?: string;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  iconBackground?: string;
};

type ProjectSection = {
  project: ProjectItem;
  groups: SessionGroup[];
};

type ProjectSectionCacheEntry = {
  project: ProjectItem;
  activeSessions: Session[];
  archivedSessions: Session[];
  availableWorktrees: WorktreeMetadata[];
  rootBranch: string | null;
  isRepo: boolean;
  buildGroupedSessions: Args['buildGroupedSessions'];
  section: ProjectSection;
};

const EMPTY_WORKTREES: WorktreeMetadata[] = [];

type Args = {
  normalizedProjects: ProjectItem[];
  getSessionsForProject: (projectId: string) => Session[];
  getArchivedSessionsForProject: (projectId: string) => Session[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  projectRepoStatus: Map<string, boolean | null>;
  projectRootBranches: Map<string, string | null>;
  lastRepoStatus: boolean;
  buildGroupedSessions: (
    sessions: Session[],
    projectRoot: string,
    availableWorktrees: WorktreeMetadata[],
    rootBranch: string | null,
    isRepo: boolean,
  ) => SessionGroup[];
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  filterSessionNodesForSearch: (nodes: SessionNode[], query: string) => SessionNode[];
  buildGroupSearchText: (group: SessionGroup) => string;
  foldersMap: SessionFoldersMap;
};

export const useSessionSidebarSections = (args: Args) => {
  const {
    normalizedProjects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject,
    projectRepoStatus,
    projectRootBranches,
    lastRepoStatus,
    buildGroupedSessions,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    foldersMap,
  } = args;
  const projectSectionCacheRef = React.useRef<Map<string, ProjectSectionCacheEntry>>(new Map());

  const projectSections = React.useMemo<ProjectSection[]>(() => {
    const previousCache = projectSectionCacheRef.current;
    const nextCache = new Map<string, ProjectSectionCacheEntry>();
    let reusedSections = 0;
    let rebuiltSections = 0;
    const sameSessions = (left: Session[], right: Session[]): boolean => (
      left.length === right.length && left.every((session, index) => session === right[index])
    );

    const sections = normalizedProjects.map((project) => {
      const activeSessions = getSessionsForProject(project.id);
      const archivedSessions = getArchivedSessionsForProject(project.id);
      const worktreesForProject = availableWorktreesByProject.get(project.normalizedPath) ?? EMPTY_WORKTREES;
      const isRepo = projectRepoStatus.has(project.id)
        ? Boolean(projectRepoStatus.get(project.id))
        : lastRepoStatus;
      const rootBranch = projectRootBranches.get(project.id) ?? null;
      const cached = previousCache.get(project.id);
      if (
        cached
        && cached.project === project
        && sameSessions(cached.activeSessions, activeSessions)
        && sameSessions(cached.archivedSessions, archivedSessions)
        && cached.availableWorktrees === worktreesForProject
        && cached.rootBranch === rootBranch
        && cached.isRepo === isRepo
        && cached.buildGroupedSessions === buildGroupedSessions
      ) {
        reusedSections += 1;
        nextCache.set(project.id, cached);
        return cached.section;
      }

      rebuiltSections += 1;
      const projectSessions = dedupeSessionsById([...activeSessions, ...archivedSessions]);
      const groups = buildGroupedSessions(
        projectSessions,
        project.normalizedPath,
        worktreesForProject,
        rootBranch,
        isRepo,
      );
      const section = { project, groups };
      nextCache.set(project.id, {
        project,
        activeSessions,
        archivedSessions,
        availableWorktrees: worktreesForProject,
        rootBranch,
        isRepo,
        buildGroupedSessions,
        section,
      });
      return section;
    });
    projectSectionCacheRef.current = nextCache;
    if (reusedSections > 0) streamPerfCount('ui.sidebar.project_section.reused', reusedSections);
    if (rebuiltSections > 0) streamPerfCount('ui.sidebar.project_section.rebuilt', rebuiltSections);
    return sections;
  }, [
    normalizedProjects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject,
    projectRepoStatus,
    lastRepoStatus,
    buildGroupedSessions,
    projectRootBranches,
  ]);

  const visibleProjectSections = React.useMemo(() => {
    return projectSections;
  }, [projectSections]);

  const groupSearchDataByGroup = React.useMemo(() => {
    const result = new WeakMap<SessionGroup, GroupSearchData>();
    if (!hasSessionSearchQuery) {
      return result;
    }

    const countNodes = (nodes: SessionNode[]): number => nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);

    visibleProjectSections.forEach((section) => {
      section.groups.forEach((group) => {
        const filteredNodes = filterSessionNodesForSearch(group.sessions, normalizedSessionSearchQuery);
        const matchedSessionCount = countNodes(filteredNodes);
        const groupMatches = buildGroupSearchText(group).includes(normalizedSessionSearchQuery);
        const scopeKey = normalizePath(group.directory ?? null);
        const scopeFolders = scopeKey ? (foldersMap[scopeKey] ?? []) : [];
        const folderNameMatchCount = scopeFolders.filter((folder) => folder.name.toLowerCase().includes(normalizedSessionSearchQuery)).length;

        result.set(group, {
          filteredNodes,
          matchedSessionCount,
          folderNameMatchCount,
          groupMatches,
          hasMatch: groupMatches || matchedSessionCount > 0 || folderNameMatchCount > 0,
        });
      });
    });

    return result;
  }, [
    hasSessionSearchQuery,
    visibleProjectSections,
    filterSessionNodesForSearch,
    normalizedSessionSearchQuery,
    buildGroupSearchText,
    foldersMap,
  ]);

  const searchableProjectSections = React.useMemo(() => {
    if (!hasSessionSearchQuery) {
      return visibleProjectSections;
    }

    return visibleProjectSections
      .map((section) => ({
        ...section,
        groups: section.groups.filter((group) => groupSearchDataByGroup.get(group)?.hasMatch === true),
      }))
      .filter((section) => section.groups.length > 0);
  }, [hasSessionSearchQuery, visibleProjectSections, groupSearchDataByGroup]);

  const sectionsForRender = hasSessionSearchQuery ? searchableProjectSections : visibleProjectSections;

  // Flat display sections: one merged group per project containing every
  // non-archived session from the project root and all of its worktrees.
  // Worktree grouping stays available in `projectSections` for data consumers
  // (bootstrap demand planning, ownership); rendering is flat.
  // The per-section cache keeps merged group references stable so the
  // memoized SessionGroupSection subtree skips unrelated update waves.
  const flatSectionCacheRef = React.useRef<WeakMap<ProjectSection, { query: string; section: ProjectSection }>>(new WeakMap());
  const flatSectionsForRender = React.useMemo<ProjectSection[]>(() => {
    const cache = flatSectionCacheRef.current;
    return sectionsForRender.map((section) => {
      const cached = cache.get(section);
      if (cached && cached.query === normalizedSessionSearchQuery) {
        return cached.section;
      }

      const nonArchivedGroups = section.groups.filter((group) => !group.isArchivedBucket);
      const archivedGroups = section.groups.filter((group) => group.isArchivedBucket);
      const sessions = nonArchivedGroups.flatMap((group) => hasSessionSearchQuery
        ? (groupSearchDataByGroup.get(group)?.filteredNodes ?? [])
        : group.sessions);
      const folderScopes = nonArchivedGroups
        .map((group) => ({
          scopeKey: group.folderScopeKey ?? normalizePath(group.directory ?? null),
          directory: group.directory ?? null,
        }))
        .filter((scope): scope is { scopeKey: string; directory: string | null } => Boolean(scope.scopeKey));
      const rootGroup = nonArchivedGroups.find((group) => group.isMain) ?? null;

      const flatGroup: SessionGroup = {
        id: 'flat',
        label: rootGroup?.label ?? '',
        branch: rootGroup?.branch ?? null,
        description: rootGroup?.description ?? null,
        isMain: true,
        isArchivedBucket: false,
        worktree: null,
        directory: rootGroup?.directory ?? section.project.normalizedPath,
        folderScopeKey: rootGroup?.folderScopeKey ?? section.project.normalizedPath,
        folderScopes,
        sessions,
      };

      if (hasSessionSearchQuery) {
        const merged = nonArchivedGroups
          .map((group) => groupSearchDataByGroup.get(group))
          .filter((data): data is GroupSearchData => Boolean(data));
        groupSearchDataByGroup.set(flatGroup, {
          filteredNodes: sessions,
          matchedSessionCount: merged.reduce((total, data) => total + data.matchedSessionCount, 0),
          folderNameMatchCount: merged.reduce((total, data) => total + data.folderNameMatchCount, 0),
          groupMatches: merged.some((data) => data.groupMatches),
          hasMatch: merged.some((data) => data.hasMatch),
        });
      }

      const flatSection: ProjectSection = {
        project: section.project,
        groups: [flatGroup, ...archivedGroups],
      };
      cache.set(section, { query: normalizedSessionSearchQuery, section: flatSection });
      return flatSection;
    });
  }, [groupSearchDataByGroup, hasSessionSearchQuery, normalizedSessionSearchQuery, sectionsForRender]);

  const searchMatchCount = React.useMemo(() => {
    if (!hasSessionSearchQuery) {
      return 0;
    }

    return sectionsForRender.reduce((total, section) => {
      return total + section.groups.reduce((groupTotal, group) => {
        const data = groupSearchDataByGroup.get(group);
        if (!data) {
          return groupTotal;
        }
        const metadataMatches = data.folderNameMatchCount + (data.groupMatches ? 1 : 0);
        return groupTotal + data.matchedSessionCount + metadataMatches;
      }, 0);
    }, 0);
  }, [hasSessionSearchQuery, sectionsForRender, groupSearchDataByGroup]);

  return {
    projectSections,
    visibleProjectSections,
    groupSearchDataByGroup,
    searchableProjectSections,
    sectionsForRender,
    flatSectionsForRender,
    searchMatchCount,
  };
};
