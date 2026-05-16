import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { dedupeSessionsById, isSessionRelatedToProject, normalizePath } from '../utils';

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

  const sessionsByDirectory = React.useMemo(() => {
    const next = new Map<string, Session[]>();
    sessions.forEach((session) => {
      const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null)
        ?? normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
      if (!directory) {
        return;
      }

      const collection = next.get(directory) ?? [];
      collection.push(session);
      next.set(directory, collection);
    });
    return next;
  }, [sessions]);

  const sessionPools = React.useMemo(() => {
    const buildChildrenMap = (input: Session[]) => {
      const byParent = new Map<string, Session[]>();
      input.forEach((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        if (!parentID) {
          return;
        }
        const bucket = byParent.get(parentID);
        if (bucket) {
          bucket.push(session);
        } else {
          byParent.set(parentID, [session]);
        }
      });
      return byParent;
    };

    const active = dedupeSessionsById(sessions);
    const archivedLike = dedupeSessionsById([...archivedSessions, ...sessions.filter((session) => !session.time?.archived)]);
    return {
      active,
      activeChildrenByParent: buildChildrenMap(active),
      archivedLike,
      archivedLikeChildrenByParent: buildChildrenMap(archivedLike),
    };
  }, [archivedSessions, sessions]);

  const includeDescendants = React.useCallback((input: Session[], childrenByParent: Map<string, Session[]>): Session[] => {
    if (input.length === 0) {
      return input;
    }
    const out: Session[] = [];
    const seen = new Set<string>();
    const queue: Session[] = [...input];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || seen.has(current.id)) {
        continue;
      }
      seen.add(current.id);
      out.push(current);
      const children = childrenByParent.get(current.id);
      if (children && children.length > 0) {
        children.forEach((child) => {
          if (!seen.has(child.id)) {
            queue.push(child);
          }
        });
      }
    }
    return out;
  }, []);

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
        const sessionsForDirectory = sessionsByDirectory.get(directory) ?? [];
        sessionsForDirectory.forEach((session) => {
          if (seen.has(session.id)) {
            return;
          }
          seen.add(session.id);
          collected.push(session);
        });
      });
      const result = includeDescendants(collected, sessionPools.activeChildrenByParent);
      return result;
    },
    [availableWorktreesByProject, includeDescendants, isVSCode, sessionPools.activeChildrenByParent, sessionsByDirectory],
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

        const base = dedupeSessionsById([...archived, ...unassignedLive]);
        const result = includeDescendants(base, sessionPools.archivedLikeChildrenByParent);
        return result;
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

      const base = dedupeSessionsById([...archived, ...unassignedLive]);
      const result = includeDescendants(base, sessionPools.archivedLikeChildrenByParent);
      return result;
    },
    [archivedSessions, availableWorktreesByProject, includeDescendants, isVSCode, sessionPools.archivedLikeChildrenByParent, sessions],
  );

  return {
    getSessionsForProject,
    getArchivedSessionsForProject,
  };
};
