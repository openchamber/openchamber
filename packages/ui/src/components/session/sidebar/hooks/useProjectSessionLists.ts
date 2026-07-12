import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { collectKnownProjectDirectories, dedupeSessionsById, isSessionRelatedToProject, normalizePath } from '../utils';

type WorktreeMeta = { path: string };

type NormalizedProject = { id: string; normalizedPath: string };

type Args = {
  isVSCode: boolean;
  sessions: Session[];
  archivedSessions: Session[];
  availableWorktreesByProject: Map<string, WorktreeMeta[]>;
  /**
   * The set of normalized projects the sidebar will render. Used in
   * Layer 4.13 to precompute the allowed directory set so the per-row
   * `sessionsByDirectory` Map only contains buckets the sidebar will
   * actually consume. With 10 projects × 5 worktrees and 100 sessions
   * per directory this drops the Map from N entries to the small
   * subset the sidebar needs.
   */
  normalizedProjects: NormalizedProject[];
};

export const useProjectSessionLists = (args: Args) => {
  const {
    isVSCode,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
    normalizedProjects,
  } = args;

  // Precompute the set of directories the sidebar will ever ask about:
  // every project's normalized path plus the path of each registered
  // worktree. Walking this set is O(P + W) per Sidebar render and lets
  // us skip the bulk of `sessions` (whose directory is not associated
  // with a known project) when building `sessionsByDirectory`.
  const knownProjectDirectories = React.useMemo(
    () => collectKnownProjectDirectories(normalizedProjects, availableWorktreesByProject, isVSCode),
    [normalizedProjects, availableWorktreesByProject, isVSCode],
  );

  const sessionsByDirectory = React.useMemo(() => {
    const next = new Map<string, Session[]>();
    sessions.forEach((session) => {
      const directory = resolveGlobalSessionDirectory(session);
      if (!directory) {
        return;
      }
      // Skip sessions whose directory doesn't belong to any known
      // project or worktree. Without this filter the Map grows with
      // every session the server has ever seen, even ones for
      // long-removed worktrees; the sidebar's downstream filters
      // would then drop them anyway.
      if (!knownProjectDirectories.has(directory)) {
        return;
      }

      const collection = next.get(directory) ?? [];
      collection.push(session);
      next.set(directory, collection);
    });
    return next;
  }, [sessions, knownProjectDirectories]);

  const getSessionsForProject = React.useCallback(
    (project: { normalizedPath: string }) => {
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
        const sessionsForDirectory: Session[] = sessionsByDirectory.get(directory) ?? [];
        sessionsForDirectory.forEach((session) => {
          if (seen.has(session.id)) {
            return;
          }
          seen.add(session.id);
          collected.push(session);
        });
      });

      return collected;
    },
    [availableWorktreesByProject, isVSCode, sessionsByDirectory],
  );

  const getArchivedSessionsForProject = React.useCallback(
    (project: { normalizedPath: string }) => {
      if (isVSCode) {
        const archived = archivedSessions.filter((session) => {
          const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
          const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);

          if (sessionDirectory) {
            return sessionDirectory === project.normalizedPath;
          }

          return projectWorktree === project.normalizedPath;
        });

        const unassignedLive = sessions.filter((session) => {
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

      const worktreesForProject = isVSCode ? [] : (availableWorktreesByProject.get(project.normalizedPath) ?? []);
      const validDirectories = new Set<string>([
        project.normalizedPath,
        ...worktreesForProject
          .map((meta) => normalizePath(meta.path) ?? meta.path)
          .filter((value): value is string => Boolean(value)),
      ]);

      const collect = (input: Session[]): Session[] => input.filter((session) =>
        isSessionRelatedToProject(session, project.normalizedPath, validDirectories, knownProjectDirectories),
      );

      const archived = collect(archivedSessions);
      const unassignedLive = sessions.filter((session) => {
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
        return isSessionRelatedToProject(session, project.normalizedPath, validDirectories, knownProjectDirectories);
      });

      return dedupeSessionsById([...archived, ...unassignedLive]);
    },
    [archivedSessions, availableWorktreesByProject, isVSCode, knownProjectDirectories, sessions],
  );

  return {
    getSessionsForProject,
    getArchivedSessionsForProject,
  };
};
