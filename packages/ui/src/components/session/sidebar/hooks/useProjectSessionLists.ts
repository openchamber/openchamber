import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { dedupeSessionsById, isSessionRelatedToProject, normalizePath } from '../utils';
import { getCompatibleSessionArchivedAt, getCompatibleSessionDirectory, getCompatibleSessionProjectWorktree } from '@/sync/compat';

type WorktreeMeta = { path: string };

type Args = {
  isVSCode: boolean;
  sessions: Session[];
  archivedSessions: Session[];
  availableWorktreesByProject: Map<string, WorktreeMeta[]>;
};

export const useProjectSessionLists = (args: Args) => {
  const {
    isVSCode,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
  } = args;

  const getSessionsForProject = React.useCallback(
    (project: { normalizedPath: string }) => {
      const worktreesForProject = isVSCode ? [] : (availableWorktreesByProject.get(project.normalizedPath) ?? []);
      const validDirectories = new Set<string>([
        project.normalizedPath,
        ...worktreesForProject
          .map((meta) => normalizePath(meta.path) ?? meta.path)
          .filter((value): value is string => Boolean(value)),
      ]);

      const matchedSessions = sessions.filter((session) =>
        isSessionRelatedToProject(session, project.normalizedPath, validDirectories),
      );

      return matchedSessions;
    },
    [availableWorktreesByProject, isVSCode, sessions],
  );

  const getArchivedSessionsForProject = React.useCallback(
    (project: { normalizedPath: string }) => {
      if (isVSCode) {
        const archived = archivedSessions.filter((session) => {
          const sessionDirectory = normalizePath(getCompatibleSessionDirectory(session));
          const projectWorktree = normalizePath(getCompatibleSessionProjectWorktree(session));

          if (sessionDirectory) {
            return sessionDirectory === project.normalizedPath;
          }

          return projectWorktree === project.normalizedPath;
        });

        const unassignedLive = sessions.filter((session) => {
          if (getCompatibleSessionArchivedAt(session)) {
            return false;
          }
          const sessionDirectory = normalizePath(getCompatibleSessionDirectory(session));
          if (sessionDirectory) {
            return false;
          }
          const projectWorktree = normalizePath(getCompatibleSessionProjectWorktree(session));
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
        if (getCompatibleSessionArchivedAt(session)) {
          return false;
        }
        const sessionDirectory = normalizePath(getCompatibleSessionDirectory(session));
        if (sessionDirectory) {
          return false;
        }
        const projectWorktree = normalizePath(getCompatibleSessionProjectWorktree(session));
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
