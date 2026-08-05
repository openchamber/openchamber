import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useGitAllBranches } from '@/stores/useGitStore';
import type { SessionNode } from '../types';
import { isPathWithinProject } from '../utils';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { useSessionUIStore } from '@/sync/session-ui-store';

export type SwitcherItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: {
    projectLabel?: string | null;
    branchLabel?: string | null;
  } | null;
};

const MAX_PARENT_SESSIONS = 7;

type SwitcherItemsOptions = {
  scopeProjectId?: string | null;
  /** How many parent sessions to return (default 7 — the desktop dropdown). */
  maxParents?: number;
};

const normalize = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

const formatProjectLabel = (project: { label?: string | null; path: string } | null): string | null => {
  if (!project) return null;
  const trimmed = project.label?.trim();
  if (trimmed) return trimmed;
  const segments = project.path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? null;
};

export const useSwitcherItems = (enabled: boolean, options: SwitcherItemsOptions = {}): SwitcherItem[] => {
  const { scopeProjectId = null, maxParents = MAX_PARENT_SESSIONS } = options;
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const projects = useProjectsStore((state) => state.projects);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore((state) => state.rankById);
  const branchesByDirectory = useGitAllBranches();
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);

  // Worktree sessions live OUTSIDE their project's path, so prefix matching
  // can't resolve their project — and their branch is known from worktree
  // discovery long before any git status is fetched for that directory.
  const worktreeInfoByPath = React.useMemo(() => {
    const map = new Map<string, { projectPath: string; branch: string | null }>();
    for (const [projectPath, worktrees] of availableWorktreesByProject) {
      const normalizedProjectPath = normalize(projectPath);
      if (!normalizedProjectPath) continue;
      for (const worktree of worktrees) {
        const worktreePath = normalize(worktree.path);
        if (!worktreePath) continue;
        map.set(worktreePath, { projectPath: normalizedProjectPath, branch: worktree.branch?.trim() || null });
      }
    }
    return map;
  }, [availableWorktreesByProject]);

  const normalizedProjects = React.useMemo(
    () => projects
      .map((project) => ({ ...project, normalizedPath: normalize(project.path) }))
      .filter((project) => project.normalizedPath),
    [projects],
  );

  const findProjectForDirectory = React.useCallback(
    (directory: string | null) => {
      if (!directory) return null;
      // Known worktree → its project, regardless of where the worktree lives.
      const worktreeInfo = worktreeInfoByPath.get(normalize(directory) ?? directory);
      if (worktreeInfo) {
        const byPath = normalizedProjects.find((project) => project.normalizedPath === worktreeInfo.projectPath);
        if (byPath) return byPath;
      }
      const matches = normalizedProjects
        .filter((project) => isPathWithinProject(directory, project.normalizedPath))
        .sort((a, b) => (b.normalizedPath?.length ?? 0) - (a.normalizedPath?.length ?? 0));
      return matches[0] ?? null;
    },
    [normalizedProjects, worktreeInfoByPath],
  );

  const items = React.useMemo<SwitcherItem[]>(() => {
    if (!enabled) return [];

    const childrenByParent = new Map<string, Session[]>();
    for (const session of activeSessions) {
      const parentId = (session as Session & { parentID?: string | null }).parentID;
      if (!parentId) continue;
      if (session.time?.archived) continue;
      const bucket = childrenByParent.get(parentId);
      if (bucket) {
        bucket.push(session);
      } else {
        childrenByParent.set(parentId, [session]);
      }
    }
    childrenByParent.forEach((list) => {
      list.sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks));
    });

    const parents = activeSessions
      .filter((session) => !session.time?.archived)
      .filter((session) => !(session as Session & { parentID?: string | null }).parentID)
      .filter((session) => {
        if (!scopeProjectId) return true;
        const directory = resolveGlobalSessionDirectory(session);
        return findProjectForDirectory(directory)?.id === scopeProjectId;
      })
      .sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks))
      .slice(0, maxParents);

    const buildNode = (session: Session): SessionNode => {
      const childSessions = childrenByParent.get(session.id) ?? [];
      return {
        session,
        children: childSessions.map((child) => buildNode(child)),
        worktree: null,
      };
    };

    return parents.map((session) => {
      const directory = resolveGlobalSessionDirectory(session);
      const matchedProject = findProjectForDirectory(directory);
      const projectLabel = formatProjectLabel(matchedProject);
      // Live git branch when available; the discovered worktree branch fills
      // in for directories whose git status hasn't been fetched yet.
      const worktreeInfo = directory ? worktreeInfoByPath.get(normalize(directory) ?? directory) : null;
      const liveBranch = directory ? branchesByDirectory.get(directory) : undefined;
      const branchLabel = liveBranch ?? worktreeInfo?.branch ?? null;
      return {
        node: buildNode(session),
        projectId: matchedProject?.id ?? null,
        groupDirectory: directory,
        secondaryMeta: {
          projectLabel,
          branchLabel: branchLabel && branchLabel !== projectLabel ? branchLabel : null,
        },
      };
    });
  }, [activeSessions, branchesByDirectory, enabled, findProjectForDirectory, maxParents, pinnedSessionIds, scopeProjectId, sessionOrderRanks, worktreeInfoByPath]);

  return items;
};
