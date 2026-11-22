import type { Project as OpenCodeProject, Session } from '@/lib/opencode/model';
import { buildMultiRunIndex } from '@/lib/multirun/runs';
import { resolveSessionNestingParentId } from '@/lib/sessionWorkLineage';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import type { SpaceMark } from '@/lib/spaces/spaces-store';
import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '../utils';
import { resolveSessionFolderOwnerKey } from './sessionFolderIdentity';
import { createSessionOwnershipIndex } from './sessionOwnership';

type SessionMenuPlacement = {
  projectId: string | null;
  folderOwnerKey: string | null;
  ownsWork: boolean;
};

type PlacementSources = {
  projects: readonly { id: string; path: string }[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  authoritativeProjects: readonly Pick<OpenCodeProject, 'id' | 'worktree'>[];
  spaces: readonly SpaceMark[];
  isVSCode: boolean;
  activeSessions: readonly Session[];
  resolveLegacyScope: (session: Session) => string | null;
  lookup: (sessionId: string) => Session | undefined;
};

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
  const isRunLane = buildMultiRunIndex(sources.activeSessions, sources.resolveLegacyScope)
    .runKeyBySessionId.has(session.id);
  return {
    projectId: owner?.projectId ?? null,
    folderOwnerKey: resolveSessionFolderOwnerKey(session, owner, isRunLane),
    ownsWork: !isRunLane
      && (!owner || owner.kind === 'project')
      && resolveSessionNestingParentId(session, sources.lookup) === null,
  };
};

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
