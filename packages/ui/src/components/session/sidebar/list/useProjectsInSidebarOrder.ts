import React from 'react';
import type { Project as OpenCodeProject, Session } from '@/lib/opencode/model';
import { getSettingsSurface } from '@/lib/settings/surface';
import { useSidebarSpaces } from '@/lib/spaces/spaces-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { normalizePath } from '../utils';
import { partitionSidebarSessions } from './sessionCollection';
import { orderByProjectRank, rankByLatestActivity, sortProjectsByOrder } from './projectSort';

const NO_PROJECTS: ProjectEntry[] = [];
const NO_IDS: string[] = [];
const NO_SESSIONS: Session[] = [];
const NO_WORKTREES = new Map<string, WorktreeMetadata[]>();
const NO_OPENCODE_PROJECTS: OpenCodeProject[] = [];

/**
 * `items` in the order the sidebar shows the projects: its project sort
 * (Manual, A to Z, Z to A, Newest, Recent), or the manual order while the
 * sidebar is in the List view, which always keeps it. Entries that are not
 * registered projects, such as the composer's Chat target, stay ahead in their
 * incoming order.
 *
 * "Recent" ranks by the newest session in each project, resolved the way the
 * sidebar resolves ownership, so only that sort reads sessions. A surface that
 * stays mounted while its list is closed (the composer's project picker)
 * passes `enabled: false`: it then reads no projects, sessions or spaces, and
 * gets back the order it last showed, or the items unchanged.
 */
export const useProjectsInSidebarOrder = <T extends { id: string }>(
  items: readonly T[],
  enabled = true,
): readonly T[] => {
  // Every sidebar sorts projects by the stored order, in either grouping.
  const isVSCode = React.useMemo(() => getSettingsSurface() === 'vscode', []);
  const projects = useProjectsStore((state) => (enabled ? state.projects : NO_PROJECTS));
  const manualOrder = useProjectsStore((state) => (enabled ? state.manualProjectOrder : NO_IDS));
  const order = useSessionDisplayStore((state) => state.projectSortOrder);
  const recent = enabled && order === 'recent';
  const sessions = useGlobalSessionsStore((state) => (recent ? state.activeSessions : NO_SESSIONS));
  // Archived sessions can tie an OpenCode project to a registered one, as in the sidebar's index.
  const archivedSessions = useGlobalSessionsStore((state) => (recent ? state.archivedSessions : NO_SESSIONS));
  const worktrees = useSessionUIStore((state) => (recent ? state.availableWorktreesByProject : NO_WORKTREES));
  const openCodeProjects = useGlobalSyncStore((state) => (recent ? state.projects : NO_OPENCODE_PROJECTS));
  const spaces = useSidebarSpaces(recent);

  // The order as a string, so a session update that moves nothing keeps the
  // rank map, and the returned list, the same object.
  const orderKey = React.useMemo(() => {
    const sorted = sortProjectsByOrder(projects, order, manualOrder);
    const ranked = recent
      ? rankByLatestActivity(sorted, order, (project) => project.id, createSessionOwnershipIndex(
        partitionSidebarSessions(sessions, isVSCode).projectSessions,
        sorted.flatMap((project) => {
          const normalizedPath = normalizePath(project.path);
          return normalizedPath ? [{ id: project.id, normalizedPath }] : [];
        }),
        worktrees,
        isVSCode,
        archivedSessions,
        openCodeProjects,
        spaces,
      ).sessionsByProject)
      : sorted;
    return ranked.map((project) => project.id).join('\n');
  }, [archivedSessions, isVSCode, manualOrder, openCodeProjects, order, projects, recent, sessions, spaces, worktrees]);
  const rankById = React.useMemo(
    () => new Map(orderKey.split('\n').map((id, index) => [id, index])),
    [orderKey],
  );
  const ordered = React.useMemo(
    () => (enabled ? orderByProjectRank(items, rankById) : null),
    [enabled, items, rankById],
  );

  // A closing popup stays on screen through its fade: keep the order it showed.
  const shownRef = React.useRef<{ items: readonly T[]; ordered: readonly T[] } | null>(null);
  if (ordered) {
    shownRef.current = { items, ordered };
    return ordered;
  }
  return shownRef.current?.items === items ? shownRef.current.ordered : items;
};
