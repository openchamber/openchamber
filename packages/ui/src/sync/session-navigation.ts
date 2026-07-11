import type { Session } from '@opencode-ai/sdk/v2';

import {
  compareSessionsByPinnedAndTime,
  isSessionRelatedToProject,
  normalizePath,
} from '@/components/session/sidebar/utils';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import {
  type SessionFocusIdentity,
  type SessionFocusScope,
  useSessionFocusStore,
} from '@/stores/useSessionFocusStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

import { getAllSyncSessions, getSyncSessions } from './sync-refs';
import { useSessionUIStore } from './session-ui-store';

type SessionWithParent = Session & { parentID?: string | null };

export type SessionNavigationTarget = Readonly<{
  scope: SessionFocusScope;
  sessionId: string;
  projectId: string | null;
  directory: string | null;
  groupKey?: string | null;
  folderAncestorIds?: readonly string[];
  visibleIndex?: number;
}>;

type SessionNavigationSnapshot = Readonly<{
  recent: readonly SessionNavigationTarget[];
  project: readonly SessionNavigationTarget[];
}>;

type SessionNavigationCommit = (target: SessionNavigationTarget) => void;

let publishedNavigationSnapshot: SessionNavigationSnapshot | null = null;
let publishedNavigationRevision = 0;

const normalizeNavigationTargets = (
  scope: SessionFocusScope,
  targets: readonly SessionNavigationTarget[],
): readonly SessionNavigationTarget[] => {
  const seen = new Set<string>();
  const normalized: SessionNavigationTarget[] = [];

  for (const target of targets) {
    if (!target.sessionId) {
      continue;
    }

    const targetKey = scope === 'recent'
      ? target.sessionId
      : `${target.projectId ?? ''}:${target.sessionId}`;
    if (seen.has(targetKey)) {
      continue;
    }
    seen.add(targetKey);

    normalized.push(target.scope === scope ? target : { ...target, scope });
  }

  return normalized;
};

/**
 * Publish the ordered session rows that the mounted sidebar actually renders.
 *
 * The returned cleanup is revision-scoped so an older sidebar/effect cleanup
 * cannot clear a newer snapshot during a remount or responsive-layout switch.
 */
export const publishSessionNavigationSnapshot = (
  snapshot: SessionNavigationSnapshot,
): (() => void) => {
  const revision = ++publishedNavigationRevision;
  publishedNavigationSnapshot = {
    recent: normalizeNavigationTargets('recent', snapshot.recent),
    project: normalizeNavigationTargets('project', snapshot.project),
  };

  return () => {
    if (publishedNavigationRevision !== revision) {
      return;
    }
    publishedNavigationSnapshot = null;
  };
};

const getSessionNavigationSnapshot = (): SessionNavigationSnapshot | null => (
  publishedNavigationSnapshot
);

export const clearSessionNavigationSnapshot = (): void => {
  publishedNavigationRevision += 1;
  publishedNavigationSnapshot = null;
};

export const isSubtaskSession = (session: Session): boolean => {
  return Boolean((session as SessionWithParent).parentID);
};

export const resolveRootSessionId = (sessionId: string | null, sessions: Session[]): string | null => {
  if (!sessionId) {
    return null;
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  let current = byId.get(sessionId);
  if (!current) {
    return sessionId;
  }

  while (current && isSubtaskSession(current)) {
    const parentID = (current as SessionWithParent).parentID;
    if (!parentID) {
      break;
    }
    const parent = byId.get(parentID);
    if (!parent) {
      return parentID;
    }
    current = parent;
  }

  return current?.id ?? sessionId;
};

/**
 * Build the legacy project-scoped fallback used before the sidebar publishes
 * its exact rendered order. Walk registered projects in store order, then root
 * (non-archived, non-subtask) sessions with the sidebar's pinned+time sort.
 */
export const getNavigableRootSessions = (): Session[] => {
  const pinnedSessionIds = useSessionPinnedStore.getState().ids;
  const projects = useProjectsStore.getState().projects;

  // Prefer the global active list (matches the multi-project sidebar). Fall
  // back to sync child stores when global bootstrap has not landed yet.
  const globalActive = useGlobalSessionsStore.getState().activeSessions;
  const allSessions = globalActive.length > 0 ? globalActive : getAllSyncSessions();

  const seen = new Set<string>();
  const ordered: Session[] = [];

  const appendMatching = (candidates: Session[]) => {
    for (const session of candidates) {
      if (seen.has(session.id)) {
        continue;
      }
      seen.add(session.id);
      ordered.push(session);
    }
  };

  for (const project of projects) {
    const projectRoot = normalizePath(project.path);
    if (!projectRoot) {
      continue;
    }

    // Path-prefix matching covers project root + nested worktrees without
    // reading session-ui-store (avoids a circular import with setSessionOpener).
    const projectSessions = allSessions
      .filter((session) => !session.time?.archived)
      .filter((session) => !isSubtaskSession(session))
      .filter((session) => isSessionRelatedToProject(session, projectRoot))
      .sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));

    appendMatching(projectSessions);
  }

  // Sessions that are not under any registered project stay reachable, but
  // trail the project tree so they never insert themselves ahead via Recent-
  // style global recency.
  const orphanSessions = allSessions
    .filter((session) => !session.time?.archived)
    .filter((session) => !isSubtaskSession(session))
    .filter((session) => !seen.has(session.id))
    .sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));

  appendMatching(orphanSessions);

  return ordered;
};

export const resolveAdjacentRootSession = (
  direction: -1 | 1,
  currentSessionId: string | null,
): Session | null => {
  const globalActive = useGlobalSessionsStore.getState().activeSessions;
  const syncAll = getAllSyncSessions();
  const allSessions = globalActive.length > 0
    ? globalActive
    : (syncAll.length > 0 ? syncAll : getSyncSessions());
  const navigableSessions = getNavigableRootSessions();
  if (navigableSessions.length === 0) {
    return null;
  }

  const rootSessionId = resolveRootSessionId(currentSessionId, allSessions);
  const currentIndex = rootSessionId
    ? navigableSessions.findIndex((session) => session.id === rootSessionId)
    : -1;

  let nextIndex = direction > 0 ? 0 : navigableSessions.length - 1;
  if (currentIndex >= 0) {
    nextIndex = (currentIndex + direction + navigableSessions.length) % navigableSessions.length;
  }

  return navigableSessions[nextIndex] ?? null;
};

export const resolveAdjacentRootSessionDirectory = (session: Session): string | null => {
  return resolveGlobalSessionDirectory(session);
};

const getNavigationSessionUniverse = (): Session[] => {
  const globalActive = useGlobalSessionsStore.getState().activeSessions;
  if (globalActive.length > 0) {
    return globalActive;
  }

  const syncAll = getAllSyncSessions();
  return syncAll.length > 0 ? syncAll : getSyncSessions();
};

const resolveFallbackProjectId = (session: Session): string | null => {
  let bestMatch: { id: string; pathLength: number } | null = null;

  for (const project of useProjectsStore.getState().projects) {
    const projectRoot = normalizePath(project.path);
    if (!projectRoot || !isSessionRelatedToProject(session, projectRoot)) {
      continue;
    }
    if (!bestMatch || projectRoot.length > bestMatch.pathLength) {
      bestMatch = { id: project.id, pathLength: projectRoot.length };
    }
  }

  return bestMatch?.id ?? null;
};

const findCurrentNavigationTargetIndex = (
  targets: readonly SessionNavigationTarget[],
  rootSessionId: string | null,
  focus: SessionFocusIdentity | null,
): number => {
  if (!rootSessionId) {
    return -1;
  }

  if (focus?.scope === 'project' && focus.projectId) {
    const projectMatch = targets.findIndex((target) => (
      target.sessionId === rootSessionId && target.projectId === focus.projectId
    ));
    if (projectMatch >= 0) {
      return projectMatch;
    }
  }

  return targets.findIndex((target) => target.sessionId === rootSessionId);
};

const cycleNavigationTargets = (
  targets: readonly SessionNavigationTarget[],
  direction: -1 | 1,
  rootSessionId: string | null,
  focus: SessionFocusIdentity | null,
): SessionNavigationTarget | null => {
  if (targets.length === 0) {
    return null;
  }

  const currentIndex = findCurrentNavigationTargetIndex(targets, rootSessionId, focus);
  if (currentIndex < 0) {
    return direction > 0 ? targets[0] ?? null : targets[targets.length - 1] ?? null;
  }

  const nextIndex = (currentIndex + direction + targets.length) % targets.length;
  return targets[nextIndex] ?? null;
};

/**
 * Resolve the next target from the focus surface the user last interacted with.
 * Recent focus stays within the published Recent rows; project focus stays in
 * the published project-tree rows. If the requested surface is unavailable,
 * project rows and finally the legacy store-derived project order are used.
 */
export const resolveAdjacentNavigationTarget = (
  direction: -1 | 1,
  currentSessionId: string | null,
  focus: SessionFocusIdentity | null = useSessionFocusStore.getState().focus,
): SessionNavigationTarget | null => {
  const allSessions = getNavigationSessionUniverse();
  const rootSessionId = resolveRootSessionId(currentSessionId, allSessions);
  const currentFocus = focus?.sessionId === currentSessionId ? focus : null;
  const requestedScope = currentFocus?.scope ?? 'project';
  const snapshot = getSessionNavigationSnapshot();

  if (snapshot) {
    const scopedTargets = snapshot[requestedScope];
    const scopedTarget = cycleNavigationTargets(
      scopedTargets,
      direction,
      rootSessionId,
      currentFocus,
    );
    if (scopedTarget) {
      return scopedTarget;
    }

    if (requestedScope === 'recent') {
      const projectTarget = cycleNavigationTargets(
        snapshot.project,
        direction,
        rootSessionId,
        currentFocus,
      );
      if (projectTarget) {
        return projectTarget;
      }
    }
  }

  const fallbackSession = resolveAdjacentRootSession(direction, currentSessionId);
  if (!fallbackSession) {
    return null;
  }

  return {
    scope: 'project',
    sessionId: fallbackSession.id,
    projectId: resolveFallbackProjectId(fallbackSession),
    directory: resolveAdjacentRootSessionDirectory(fallbackSession),
  };
};

/**
 * Shared keyboard/menu navigation entrypoint. Focus is published before the
 * authoritative session commit so duplicate sidebar rows can highlight the
 * correct surface immediately.
 */
export const navigateAdjacentSession = (
  direction: -1 | 1,
  currentSessionId: string | null,
  commit: SessionNavigationCommit = (target) => {
    useSessionUIStore.getState().setCurrentSession(target.sessionId, target.directory);
  },
): SessionNavigationTarget | null => {
  const target = resolveAdjacentNavigationTarget(direction, currentSessionId);
  if (!target) {
    return null;
  }

  useSessionFocusStore.getState().setFocus({
    scope: target.scope,
    sessionId: target.sessionId,
    projectId: target.projectId,
  });
  commit(target);
  return target;
};
