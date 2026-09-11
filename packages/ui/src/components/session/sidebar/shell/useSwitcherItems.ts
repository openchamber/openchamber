import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { isBtwSession } from '@/lib/sessionBtwMetadata';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useGitAllBranches } from '@/stores/useGitStore';
import type { SessionNode } from '../types';
import { isPathWithinProject } from '../utils';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { buildWorktreeByPathIndex } from '../worktreeIndex';
import { normalizePath } from '../utils';

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
  currentSessionId?: string | null;
  /** How many parent sessions to return (default 7 — the desktop dropdown). */
  maxParents?: number;
};

const formatProjectLabel = (project: { label?: string | null; path: string } | null): string | null => {
  if (!project) return null;
  const trimmed = project.label?.trim();
  if (trimmed) return trimmed;
  const segments = project.path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? null;
};

export const findSwitcherItemAncestorIds = (items: SwitcherItem[], sessionId: string): string[] | null => {
  const visit = (node: SessionNode, ancestors: string[]): string[] | null => {
    if (node.session.id === sessionId) return ancestors;
    for (const child of node.children) {
      const result = visit(child, [...ancestors, node.session.id]);
      if (result) return result;
    }
    return null;
  };

  for (const item of items) {
    const result = visit(item.node, []);
    if (result) return result;
  }
  return null;
};

export const selectSwitcherParents = (
  activeSessions: Session[],
  pinnedSessionIds: Set<string>,
  sessionOrderRanks: Map<string, number>,
  scopeProjectId: string | null,
  currentSessionId: string | null,
  getProjectId: (session: Session) => string | null,
  maxParents = MAX_PARENT_SESSIONS,
  isExcluded?: (session: Session) => boolean,
): Session[] => {
  const sessionsById = new Map(activeSessions.map((session) => [session.id, session]));
  const isEligibleParent = (session: Session): boolean => {
    if (session.time?.archived) return false;
    if (isExcluded?.(session)) return false;
    // SAFETY: the SDK Session type omits parentID, but the server includes it on child sessions.
    if ((session as Session & { parentID?: string | null }).parentID) return false;
    return !scopeProjectId || getProjectId(session) === scopeProjectId;
  };
  const parents = activeSessions
    .filter(isEligibleParent)
    .sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks));

  const currentSession = currentSessionId ? sessionsById.get(currentSessionId) ?? null : null;
  let currentRoot: Session | null = currentSession?.time?.archived ? null : currentSession;
  const visited = new Set<string>();
  while (currentRoot) {
    // SAFETY: the SDK Session type omits parentID, but the server includes it on child sessions.
    const parentId = (currentRoot as Session & { parentID?: string | null }).parentID;
    if (!parentId) break;
    if (visited.has(parentId)) {
      currentRoot = null;
      break;
    }
    visited.add(parentId);
    currentRoot = sessionsById.get(parentId) ?? null;
  }

  const currentRootIndex = currentRoot && isEligibleParent(currentRoot) ? parents.indexOf(currentRoot) : -1;
  if (currentRootIndex >= maxParents) {
    return [...parents.slice(0, Math.max(0, maxParents - 1)), currentRoot!];
  }
  return parents.slice(0, maxParents);
};

export const useSwitcherItems = (enabled: boolean, options: SwitcherItemsOptions = {}): SwitcherItem[] => {
  const { scopeProjectId = null, currentSessionId = null, maxParents = MAX_PARENT_SESSIONS } = options;
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const projects = useProjectsStore((state) => state.projects);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore((state) => state.rankById);
  const branchesByDirectory = useGitAllBranches();
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const normalizedProjects = React.useMemo(
    () => projects
      .map((project) => ({ ...project, normalizedPath: normalizePath(project.path) }))
      .filter((project) => project.normalizedPath),
    [projects],
  );

  // Worktree sessions live OUTSIDE their project's path, so prefix matching
  // can't resolve their project — and their branch is known from worktree
  // discovery long before any git status is fetched for that directory.
  // Shared exact index: normalized keys, project-root exclusion, first-wins.
  // Already live-first below (`liveBranch ?? stored`), so no branch change.
  const worktreeByPath = React.useMemo(
    () => buildWorktreeByPathIndex(availableWorktreesByProject, normalizedProjects),
    [availableWorktreesByProject, normalizedProjects],
  );

  const findProjectForDirectory = React.useCallback(
    (directory: string | null) => {
      if (!directory) return null;
      // Known worktree → its project, regardless of where the worktree lives.
      const worktreeHit = worktreeByPath.get(normalizePath(directory) ?? directory);
      if (worktreeHit) return worktreeHit.project;
      const matches = normalizedProjects
        .filter((project) => isPathWithinProject(directory, project.normalizedPath))
        .sort((a, b) => (b.normalizedPath?.length ?? 0) - (a.normalizedPath?.length ?? 0));
      return matches[0] ?? null;
    },
    [normalizedProjects, worktreeByPath],
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

    const parents = selectSwitcherParents(
      activeSessions,
      pinnedSessionIds,
      sessionOrderRanks,
      scopeProjectId,
      currentSessionId,
      (session) => findProjectForDirectory(resolveGlobalSessionDirectory(session))?.id ?? null,
      maxParents,
      // btw forks stay hidden until promoted to a full session
      (session) => isBtwSession(session) || (isVSCode && isChatDirectoryPath(resolveGlobalSessionDirectory(session))),
    );

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
      const worktreeHit = directory ? worktreeByPath.get(normalizePath(directory) ?? directory) : null;
      const liveBranch = directory ? branchesByDirectory.get(directory) : undefined;
      const branchLabel = liveBranch ?? worktreeHit?.meta.branch?.trim() ?? null;
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
  }, [activeSessions, branchesByDirectory, currentSessionId, enabled, findProjectForDirectory, isVSCode, maxParents, pinnedSessionIds, scopeProjectId, sessionOrderRanks, worktreeByPath]);

  return items;
};
