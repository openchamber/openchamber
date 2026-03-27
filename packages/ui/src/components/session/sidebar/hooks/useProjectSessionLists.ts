import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { dedupeSessionsById, isSessionRelatedToProject, normalizePath } from '../utils';

type WorktreeMeta = { path: string };

type Args = {
  isVSCode: boolean;
  sessions: Session[];
  archivedSessions: Session[];
  sessionsByDirectory: Map<string, Session[]>;
  getSessionsByDirectory: (directory: string) => Session[];
  availableWorktreesByProject: Map<string, WorktreeMeta[]>;
};

export const useProjectSessionLists = (args: Args) => {
  const {
    isVSCode,
    sessions,
    archivedSessions,
    sessionsByDirectory,
    getSessionsByDirectory,
    availableWorktreesByProject,
  } = args;

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
        const sessionsForDirectory = sessionsByDirectory.get(directory) ?? getSessionsByDirectory(directory);
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
    [availableWorktreesByProject, getSessionsByDirectory, isVSCode, sessionsByDirectory],
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
        isSessionRelatedToProject(session, project.normalizedPath, validDirectories),
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
        return projectWorktree === project.normalizedPath || projectWorktree.startsWith(`${project.normalizedPath}/`);
      });

      return dedupeSessionsById([...archived, ...unassignedLive]);
    },
    [archivedSessions, availableWorktreesByProject, isVSCode, sessions],
  );

  return {
    getSessionsForProject,
    getArchivedSessionsForProject,
  };
};
