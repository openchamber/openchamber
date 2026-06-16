import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  dedupeSessionsById,
  isSessionRelatedToProject,
  isSubtaskSession,
  normalizePath,
} from '../utils';

type WorktreeMeta = { path: string };

export type ProjectSessionListsArgs = {
  isVSCode: boolean;
  sessions: Session[];
  archivedSessions: Session[];
  availableWorktreesByProject: Map<string, WorktreeMeta[]>;
  showSubagentSessionsInSidebar: boolean;
};

type ProjectSessionLists = {
  getSessionsForProject: (project: { normalizedPath: string }) => Session[];
  getArchivedSessionsForProject: (project: { normalizedPath: string }) => Session[];
  getSubtaskCountForProject: (project: { normalizedPath: string }) => number;
};

export const computeProjectSessionLists = (args: ProjectSessionListsArgs): ProjectSessionLists => {
  const { isVSCode, sessions, archivedSessions, availableWorktreesByProject, showSubagentSessionsInSidebar } = args;

  // When the toggle is OFF, subagent sessions are filtered out of the live
  // top-level list. They remain reachable from the parent chat and from
  // SubagentsPanel; they are NOT sidebar citizens.
  const liveTopLevelSessions = showSubagentSessionsInSidebar
    ? sessions
    : sessions.filter((session) => !isSubtaskSession(session));

  // Same visibility rule for the archived bucket: hidden subagents should not
  // surface there either, even when their parent is archived.
  const visibleArchivedSessions = showSubagentSessionsInSidebar
    ? archivedSessions
    : archivedSessions.filter((session) => !isSubtaskSession(session));

  // Count hidden subagents per directory for future badges. Empty when the
  // toggle is ON (no subagent is "hidden" in that mode).
  const subtaskCountByDirectory = new Map<string, number>();
  if (!showSubagentSessionsInSidebar) {
    sessions.forEach((session) => {
      if (!isSubtaskSession(session)) return;
      const directory = resolveGlobalSessionDirectory(session);
      if (!directory) return;
      subtaskCountByDirectory.set(directory, (subtaskCountByDirectory.get(directory) ?? 0) + 1);
    });
  }

  const sessionsByDirectory = new Map<string, Session[]>();
  liveTopLevelSessions.forEach((session) => {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) {
      return;
    }
    const collection = sessionsByDirectory.get(directory) ?? [];
    collection.push(session);
    sessionsByDirectory.set(directory, collection);
  });

  const getSessionsForProject = (project: { normalizedPath: string }): Session[] => {
    const worktreesForProject = isVSCode ? [] : (availableWorktreesByProject.get(project.normalizedPath) ?? []);
    const directories = [
      project.normalizedPath,
      ...worktreesForProject
        .map((meta) => normalizePath(meta.path) ?? meta.path)
        .filter((value): value is string => Boolean(value)),
    ];

    const seen = new Set<string>();
    const collected: Session[] = [];

    directories.forEach((directory) => {
      const sessionsForDirectory = sessionsByDirectory.get(directory) ?? [];
      sessionsForDirectory.forEach((session) => {
        if (seen.has(session.id)) {
          return;
        }
        seen.add(session.id);
        collected.push(session);
      });
    });

    return collected;
  };

  const getArchivedSessionsForProject = (project: { normalizedPath: string }): Session[] => {
    if (isVSCode) {
      const archived = visibleArchivedSessions.filter((session) => {
        const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
        const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);

        if (sessionDirectory) {
          return sessionDirectory === project.normalizedPath;
        }

        return projectWorktree === project.normalizedPath;
      });

      const unassignedLive = liveTopLevelSessions.filter((session) => {
        if (session.time?.archived) {
          return false;
        }
        const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
        if (sessionDirectory) {
          return false;
        }
        const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
        return projectWorktree === project.normalizedPath;
      });

      return dedupeSessionsById([...archived, ...unassignedLive]);
    }

    const worktreesForProject = availableWorktreesByProject.get(project.normalizedPath) ?? [];
    const validDirectories = new Set<string>([
      project.normalizedPath,
      ...worktreesForProject
        .map((meta) => normalizePath(meta.path) ?? meta.path)
        .filter((value): value is string => Boolean(value)),
    ]);

    const collect = (input: Session[]): Session[] => input.filter((session) =>
      isSessionRelatedToProject(session, project.normalizedPath, validDirectories),
    );

    const archived = collect(visibleArchivedSessions);
    const unassignedLive = liveTopLevelSessions.filter((session) => {
      if (session.time?.archived) {
        return false;
      }
      const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      if (sessionDirectory) {
        return false;
      }
      const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
      if (!projectWorktree) {
        return false;
      }
      return projectWorktree === project.normalizedPath || projectWorktree.startsWith(`${project.normalizedPath}/`);
    });

    return dedupeSessionsById([...archived, ...unassignedLive]);
  };

  const getSubtaskCountForProject = (project: { normalizedPath: string }): number => {
    if (showSubagentSessionsInSidebar) return 0;
    let count = 0;
    subtaskCountByDirectory.forEach((value, directory) => {
      if (directory === project.normalizedPath || directory.startsWith(`${project.normalizedPath}/`)) {
        count += value;
      }
    });
    return count;
  };

  return {
    getSessionsForProject,
    getArchivedSessionsForProject,
    getSubtaskCountForProject,
  };
};

export const useProjectSessionLists = (
  args: Omit<ProjectSessionListsArgs, 'showSubagentSessionsInSidebar'>,
): ProjectSessionLists => {
  const { isVSCode, sessions, archivedSessions, availableWorktreesByProject } = args;
  const showSubagentSessionsInSidebar = useUIStore((state) => state.showSubagentSessionsInSidebar);
  return React.useMemo(
    () => computeProjectSessionLists({
      isVSCode, sessions, archivedSessions, availableWorktreesByProject,
      showSubagentSessionsInSidebar,
    }),
    [isVSCode, sessions, archivedSessions, availableWorktreesByProject, showSubagentSessionsInSidebar],
  );
};
