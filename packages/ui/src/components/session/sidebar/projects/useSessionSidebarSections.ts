import React from 'react';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup } from '../types';
import { dedupeSessionsById, normalizePath } from '../utils';
import type { WorktreeMetadata } from '@/types/worktree';
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
  groupingSessions: Session[];
  availableWorktrees: WorktreeMetadata[];
  rootBranch: string | null;
  /** Current branch of every worktree directory the section renders. */
  worktreeBranchesKey: string;
  /** Lifecycle ranks of the sessions that order the section's worktrees. */
  worktreeRanksKey: string;
  isRepo: boolean;
  buildGroupedSessions: Args['buildGroupedSessions'];
  section: ProjectSection;
};

const worktreeBranchesKeyFor = (
  worktrees: WorktreeMetadata[],
  gitBranches: ReadonlyMap<string, string | null>,
): string => worktrees
  .map((worktree) => {
    const directory = normalizePath(worktree.path) ?? worktree.path;
    return `${directory}=${gitBranches.get(directory) ?? ''}`;
  })
  .join('\n');

// Ranks only order worktree groups, so a project without worktrees has none
// to compare.
const worktreeRanksKeyFor = (
  sessions: Session[],
  worktrees: WorktreeMetadata[],
  sessionOrderRanks: ReadonlyMap<string, number>,
): string => worktrees.length === 0
  ? ''
  : sessions.map((session) => sessionOrderRanks.get(session.id) ?? '').join(',');

const EMPTY_WORKTREES: WorktreeMetadata[] = [];

type Args = {
  normalizedProjects: ProjectItem[];
  getSessionsForProject: (projectId: string) => Session[];
  getArchivedSessionsForProject: (projectId: string) => Session[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  projectRepoStatus: Map<string, boolean | null>;
  projectRootBranches: Map<string, string | null>;
  gitBranches: ReadonlyMap<string, string | null>;
  /** The ranks `buildGroupedSessions` orders worktrees by; it reads them at call time. */
  sessionOrderRanks: ReadonlyMap<string, number>;
  lastRepoStatus: boolean;
  buildGroupedSessions: (
    sessions: Session[],
    projectRoot: string,
    availableWorktrees: WorktreeMetadata[],
    rootBranch: string | null,
    isRepo: boolean,
  ) => SessionGroup[];
  getGroupingSessions: (sessions: readonly Session[]) => Session[];
};

export const useSessionSidebarSections = (args: Args) => {
  const {
    normalizedProjects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject,
    projectRepoStatus,
    projectRootBranches,
    gitBranches,
    sessionOrderRanks,
    lastRepoStatus,
    buildGroupedSessions,
    getGroupingSessions,
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
      const projectSessions = dedupeSessionsById([...activeSessions, ...archivedSessions]);
      const groupingSessions = getGroupingSessions(projectSessions);
      const worktreesForProject = availableWorktreesByProject.get(project.normalizedPath) ?? EMPTY_WORKTREES;
      const isRepo = projectRepoStatus.has(project.id)
        ? Boolean(projectRepoStatus.get(project.id))
        : lastRepoStatus;
      const rootBranch = projectRootBranches.get(project.id) ?? null;
      const worktreeBranchesKey = worktreeBranchesKeyFor(worktreesForProject, gitBranches);
      const worktreeRanksKey = worktreeRanksKeyFor(activeSessions, worktreesForProject, sessionOrderRanks);
      const cached = previousCache.get(project.id);
      if (
        cached
        && cached.project === project
        && sameSessions(cached.activeSessions, activeSessions)
        && sameSessions(cached.archivedSessions, archivedSessions)
        && sameSessions(cached.groupingSessions, groupingSessions)
        && cached.availableWorktrees === worktreesForProject
        && cached.rootBranch === rootBranch
        && cached.worktreeBranchesKey === worktreeBranchesKey
        && cached.worktreeRanksKey === worktreeRanksKey
        && cached.isRepo === isRepo
        && cached.buildGroupedSessions === buildGroupedSessions
      ) {
        reusedSections += 1;
        nextCache.set(project.id, cached);
        return cached.section;
      }

      rebuiltSections += 1;
      if (cached) {
        // Diagnostic: name what invalidated the cached section so a sidebar
        // that rebuilds on every session switch can be traced to its input.
        const reason = cached.project !== project ? 'project'
          : !sameSessions(cached.activeSessions, activeSessions) ? 'sessions'
          : !sameSessions(cached.archivedSessions, archivedSessions) ? 'archived'
          : !sameSessions(cached.groupingSessions, groupingSessions) ? 'lineage'
          : cached.availableWorktrees !== worktreesForProject ? 'worktrees'
          : cached.rootBranch !== rootBranch ? 'branch'
          : cached.worktreeBranchesKey !== worktreeBranchesKey ? 'worktreeBranches'
          : cached.worktreeRanksKey !== worktreeRanksKey ? 'worktreeRanks'
          : cached.isRepo !== isRepo ? 'repo'
          : 'builder';
        streamPerfCount(`ui.sidebar.project_section.rebuilt_reason.${reason}`);
      }
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
        groupingSessions,
        availableWorktrees: worktreesForProject,
        rootBranch,
        worktreeBranchesKey,
        worktreeRanksKey,
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
    getGroupingSessions,
    projectRootBranches,
    gitBranches,
    sessionOrderRanks,
  ]);

  // Flat display sections: one merged group per project containing every
  // non-archived session from the project root and all of its worktrees.
  // Worktree grouping stays available in `projectSections` for data consumers
  // (bootstrap demand planning, ownership); rendering is flat.
  // The per-section cache keeps merged group references stable so the
  // memoized SessionGroupSection subtree skips unrelated update waves.
  const flatSectionCacheRef = React.useRef<WeakMap<ProjectSection, ProjectSection>>(new WeakMap());
  const flatSectionsForRender = React.useMemo<ProjectSection[]>(() => {
    const cache = flatSectionCacheRef.current;
    return projectSections.map((section) => {
      const cached = cache.get(section);
      if (cached) return cached;

      const nonArchivedGroups = section.groups.filter((group) => !group.isArchivedBucket);
      const archivedGroups = section.groups.filter((group) => group.isArchivedBucket);
      const sessions = nonArchivedGroups.flatMap((group) => group.sessions);
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

      const flatSection: ProjectSection = {
        project: section.project,
        groups: [flatGroup, ...archivedGroups],
      };
      cache.set(section, flatSection);
      return flatSection;
    });
  }, [projectSections]);

  return { projectSections, flatSectionsForRender };
};
