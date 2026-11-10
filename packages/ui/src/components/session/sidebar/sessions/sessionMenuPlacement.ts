import type { Project as OpenCodeProject, Session } from '@/lib/opencode/model';
import { buildMultiRunIndex } from '@/lib/multirun/runs';
import { resolveSessionNestingParentId } from '@/lib/sessionWorkLineage';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import type { SpaceMark } from '@/lib/spaces/spaces-store';
import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '../utils';
import { resolveSessionFolderOwnerKey } from './sessionFolderIdentity';
import { createSessionOwnershipIndex } from './sessionOwnership';

/** Where a session sits in the sidebar, for a session menu opened outside it. */
export type SessionMenuPlacement = {
  projectId: string | null;
  folderOwnerKey: string | null;
  /** Its sidebar row is a work of its own, so the menu offers Track / Done. */
  ownsWork: boolean;
};

type PlacementSources = {
  projects: readonly { id: string; path: string }[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  authoritativeProjects: readonly Pick<OpenCodeProject, 'id' | 'worktree'>[];
  spaces: readonly SpaceMark[];
  isVSCode: boolean;
  /** The active sessions the sidebar lists, for multi-run membership. */
  activeSessions: readonly Session[];
  /** The scope a legacy run's title identity is read in, as the sidebar's run index reads it. */
  resolveLegacyScope: (session: Session) => string | null;
  lookup: (sessionId: string) => Session | undefined;
};

/**
 * The placement the sidebar gives `session`, resolved by the same ownership
 * index and folder rule its rows use.
 */
export const resolveSessionMenuPlacement = (session: Session, sources: PlacementSources): SessionMenuPlacement => {
  const archived = Boolean(session.time?.archived);
  const projects = sources.projects.flatMap((project) => {
    const normalizedPath = normalizePath(project.path);
    return normalizedPath ? [{ id: project.id, normalizedPath }] : [];
  });
  const ownership = createSessionOwnershipIndex(
    archived ? [] : [session],
    projects,
    sources.availableWorktreesByProject,
    sources.isVSCode,
    archived ? [session] : [],
    sources.authoritativeProjects,
    sources.spaces,
  );
  const owner = ownership.bySessionId.get(session.id);
  // A run needs two active members, as in the sidebar: the survivor that
  // Keep leaves is an ordinary session again.
  const isRunLane = buildMultiRunIndex(sources.activeSessions, sources.resolveLegacyScope)
    .runKeyBySessionId.has(session.id);
  return {
    projectId: owner?.projectId ?? null,
    folderOwnerKey: resolveSessionFolderOwnerKey(session, owner, isRunLane),
    // A worktree or a space is the work of the sessions in it, a run's row
    // owns its lanes, and a review or btw session belongs to the work it
    // nests under.
    ownsWork: !isRunLane
      && (!owner || owner.kind === 'project')
      && resolveSessionNestingParentId(session, sources.lookup) === null,
  };
};

/**
 * The sessions in work of the work `root` heads: it and the reviews and btw
 * sessions nested under it, past subagents, whose own state never counts.
 * The sidebar's `collectSessionWorkInWork` over a row's tree, for a session
 * that has no row at hand.
 */
export const collectNestedWorkInWork = (root: Session, sessions: readonly Session[]): Session[] => {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const nestedByParentId = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.parentID || session.time?.archived) continue;
    const parentId = resolveSessionNestingParentId(session, (id) => byId.get(id));
    if (!parentId) continue;
    const siblings = nestedByParentId.get(parentId);
    if (siblings) siblings.push(session);
    else nestedByParentId.set(parentId, [session]);
  }
  const inWork: Session[] = [];
  const seen = new Set<string>();
  const stack: Session[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (isSessionInWork(current)) inWork.push(current);
    stack.push(...(nestedByParentId.get(current.id) ?? []));
  }
  return inWork;
};
