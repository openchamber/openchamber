import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useLiveSessionsExcluding } from '@/sync/sync-context';
import {
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { normalizePath } from '../utils';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { isVSCodeWithoutWorkspace } from '@/lib/vscodeBootstrap';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { isBtwSession } from '@/lib/sessionBtwMetadata';
import { isSubagentSession, resolveSessionNestingParentId } from '@/lib/sessionWorkLineage';
import type { GlobalSessionStructure } from '@/stores/globalSessionStructure';
import { countSyncPerformance } from '@/sync/performance-diagnostics';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { haveSameSidebarHierarchy, haveSameSidebarStructure } from './sidebarStructureKey';
import { useSidebarReadsActivityTime } from './useSidebarReadsActivityTime';
import type { SessionNode } from '../types';
import type { ReadOnlySessionAssociation } from '@/lib/worktrees/readOnlySessionAssociation';

type ProjectSidebarActiveSessionsArgs = {
  globalActiveSessions: Session[];
  liveSessions: Session[];
  knownDirectories: Set<string>;
  isVSCode: boolean;
  nestedSessionOwners?: ReadonlyMap<string, ReadOnlySessionAssociation>;
};

type SidebarSessionPartitions = {
  projectSessions: Session[];
  chatSessions: Session[];
};

const nestingParentResolver = (sessionById: ReadonlyMap<string, Session>) => (
  (session: Session): string | null => resolveSessionNestingParentId(session, (id) => sessionById.get(id))
);

export const partitionSidebarSessions = (
  sessions: readonly Session[],
  isVSCode: boolean,
): SidebarSessionPartitions => {
  const projectSessions: Session[] = [];
  const chatSessions: Session[] = [];
  const excludeChats = isVSCode && !isVSCodeWithoutWorkspace();
  for (const session of sessions) {
    if (isBtwSession(session)) continue;
    if (isChatDirectoryPath(session.directory)) {
      if (excludeChats) continue;
      chatSessions.push(session);
      continue;
    }
    projectSessions.push(session);
  }
  return { projectSessions, chatSessions };
};


const isKnownActiveSessionDirectory = (
  session: Session,
  knownDirectories: Set<string>,
  isVSCode: boolean,
): boolean => {
  const normalized = normalizePath(resolveGlobalSessionDirectory(session));
  const directory = isVSCode ? normalized?.toLowerCase() : normalized;
  if (!directory) return false;
  if (!isVSCode && isSpaceDirectory(directory)) return true;
  if (knownDirectories.size === 0) return false;
  return knownDirectories.has(directory) || (!isVSCode && [...knownDirectories].some((root) => directory.startsWith(root.endsWith('/') ? root : `${root}/`)));
};

const hasExactActiveAssociation = (
  session: Session,
  nestedSessionOwners: ReadonlyMap<string, ReadOnlySessionAssociation> | undefined,
): boolean => {
  if (session.time?.archived || session.parentID) return false;
  const association = nestedSessionOwners?.get(session.id);
  return Boolean(association && normalizePath(resolveGlobalSessionDirectory(session)) === normalizePath(association.directory));
};

const keepKnownSessionsWithDescendants = (
  sessions: readonly Session[],
  isKnown: (session: Session) => boolean,
  anchors: readonly Session[],
): Session[] => {
  const sessionById = new Map([...anchors, ...sessions].map((session) => [session.id, session]));
  const nestingParentOf = nestingParentResolver(sessionById);
  const kept = new Map<string, boolean>(anchors.map((anchor) => [anchor.id, true]));
  const keeps = (session: Session): boolean => {
    const cached = kept.get(session.id);
    if (cached !== undefined) return cached;
    kept.set(session.id, false);
    const parent = isKnown(session) ? null : sessionById.get(nestingParentOf(session) ?? '');
    const result = parent === null || Boolean(parent && keeps(parent));
    kept.set(session.id, result);
    return result;
  };
  return sessions.filter(keeps);
};

export const projectSidebarActiveSessions = ({
  globalActiveSessions,
  liveSessions,
  knownDirectories,
  isVSCode,
  nestedSessionOwners,
}: ProjectSidebarActiveSessionsArgs): Session[] => {
  const sessions = [...globalActiveSessions];
  const knownIds = new Set(globalActiveSessions.map((session) => session.id));
  const knownDirectoryKeys = new Set([...knownDirectories].map((directory) => isVSCode ? directory.toLowerCase() : directory));

  for (const session of liveSessions) {
    if (knownIds.has(session.id)) continue;
    sessions.push(session);
  }

  const partition = partitionSidebarSessions(sessions, isVSCode);
  return keepKnownSessionsWithDescendants(
    partition.projectSessions,
    (session) => isKnownActiveSessionDirectory(session, knownDirectoryKeys, isVSCode)
      || (!isVSCode && hasExactActiveAssociation(session, nestedSessionOwners)),
    partition.chatSessions,
  );
};

export const projectSidebarCollection = (args: ProjectSidebarActiveSessionsArgs): Session[] => {
  return projectSidebarActiveSessions(args);
};

const mergeSidebarSessionSources = (
  globalActiveSessions: readonly Session[],
  liveSessions: readonly Session[],
): Session[] => {
  const sessions = [...globalActiveSessions];
  const knownIds = new Set(globalActiveSessions.map((session) => session.id));
  for (const session of liveSessions) {
    if (knownIds.has(session.id)) continue;
    knownIds.add(session.id);
    sessions.push(session);
  }
  return sessions;
};

export const getDescendantIds = (
  childrenMap: ReadonlyMap<string, readonly Session[]>,
  sessionId: string,
): string[] => {
  const descendants: string[] = [];
  const visited = new Set<string>([sessionId]);
  const visit = (parentId: string): void => {
    for (const child of childrenMap.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      descendants.push(child.id);
      visit(child.id);
    }
  };
  visit(sessionId);
  return descendants;
};

export const listedAsRoot = (
  session: Session,
  nestedSessionIds: ReadonlySet<string>,
  showSubagentSessions: boolean,
): boolean => !nestedSessionIds.has(session.id) && (showSubagentSessions || !isSubagentSession(session));

export const buildActiveSessionNode = (
  childrenMap: ReadonlyMap<string, readonly Session[]>,
  session: Session,
): SessionNode => {
  const visited = new Set<string>([session.id]);
  const build = (current: Session): SessionNode => ({
    session: current,
    children: (childrenMap.get(current.id) ?? []).flatMap((child) => {
      if (child.time?.archived || visited.has(child.id)) return [];
      visited.add(child.id);
      return [build(child)];
    }),
    worktree: null,
  });
  return build(session);
};

type SidebarSessionProjectionArgs = ProjectSidebarActiveSessionsArgs & {
  pinnedSessionIds: Set<string>;
  sessionOrderRanks: ReadonlyMap<string, number>;
};

type SidebarSessionStructureArgs = Omit<ProjectSidebarActiveSessionsArgs, 'globalActiveSessions'> & {
  globalActiveSessions?: readonly Session[];
  globalStructure?: GlobalSessionStructure;
};

const buildSidebarSessionStructure = ({
  globalActiveSessions,
  liveSessions,
  knownDirectories,
  isVSCode,
  nestedSessionOwners,
  globalStructure,
}: SidebarSessionStructureArgs) => {
  countSyncPerformance('sidebarStructureBuilds');
  const indexedGlobalSessions = globalActiveSessions ?? [];
  const visibleSessions = mergeSidebarSessionSources(indexedGlobalSessions, liveSessions);
  const partition = partitionSidebarSessions(visibleSessions, isVSCode);
  const knownDirectoryKeys = new Set([...knownDirectories].map((directory) => isVSCode ? directory.toLowerCase() : directory));
  const projectSessions = keepKnownSessionsWithDescendants(
    partition.projectSessions,
    (session) => isKnownActiveSessionDirectory(session, knownDirectoryKeys, isVSCode)
      || (!isVSCode && hasExactActiveAssociation(session, nestedSessionOwners)),
    partition.chatSessions,
  );
  const sessions = [...projectSessions, ...partition.chatSessions];
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  return {
    chatSessionIds: new Set(partition.chatSessions.map((session) => session.id)),
    projectSessions,
    sessionById,
    sessions,
    hierarchy: globalStructure ? {
      rootIds: globalStructure.activeRootIds,
      childrenByParentId: globalStructure.activeChildrenByParentId,
    } : undefined,
  };
};

const EMPTY_PINNED_SESSION_IDS = new Set<string>();

const orderSidebarSessionStructure = (
  structure: ReturnType<typeof buildSidebarSessionStructure>,
  pinnedSessionIds: Set<string>,
  sessionOrderRanks: ReadonlyMap<string, number>,
) => {
  const orderedSessions = orderSessionsByLifecycleScopes(
    structure.sessions,
    pinnedSessionIds,
    sessionOrderRanks,
    structure.hierarchy,
  );
  const childrenMap = new Map<string, Session[]>();
  const nestingParentOf = nestingParentResolver(structure.sessionById);
  for (const session of orderedSessions) {
    const parentID = nestingParentOf(session);
    if (!parentID) continue;
    const siblings = childrenMap.get(parentID) ?? [];
    siblings.push(session);
    childrenMap.set(parentID, siblings);
  }
  return {
    chatSessions: orderedSessions.filter((session) => structure.chatSessionIds.has(session.id)),
    childrenMap,
    orderedSessions,
  };
};

export const buildSidebarSessionProjection = ({
  globalActiveSessions,
  liveSessions,
  knownDirectories,
  isVSCode,
  pinnedSessionIds,
  sessionOrderRanks,
  nestedSessionOwners,
}: SidebarSessionProjectionArgs) => {
  const structure = buildSidebarSessionStructure({
    globalActiveSessions,
    liveSessions,
    knownDirectories,
    isVSCode,
    nestedSessionOwners,
  });
  const ordering = orderSidebarSessionStructure(structure, pinnedSessionIds, sessionOrderRanks);
  const projectSessionIds = new Set(structure.projectSessions.map((session) => session.id));
  return {
    ...ordering,
    projectSessions: ordering.orderedSessions.filter((session) => projectSessionIds.has(session.id)),
    sessionById: structure.sessionById,
  };
};

type UseSessionProjectCollectionArgs = {
  knownDirectories: Set<string>;
  isVSCode: boolean;
  isVisible: boolean;
  searchActive: boolean;
  projectSortOrder: ProjectSortOrder;
};

const useStructurallyStableSessions = (sessions: Session[], readsActivityTime: boolean): Session[] => {
  const previousRef = React.useRef<{ sessions: Session[]; readsActivityTime: boolean } | null>(null);
  return React.useMemo(() => {
    const previous = previousRef.current;
    if (previous && previous.readsActivityTime === readsActivityTime && haveSameSidebarStructure(previous.sessions, sessions, readsActivityTime)) {
      countSyncPerformance('sidebarStructureReuses');
      return previous.sessions;
    }
    previousRef.current = { sessions, readsActivityTime };
    return sessions;
  }, [readsActivityTime, sessions]);
};

const useStableHierarchy = (structure: GlobalSessionStructure): GlobalSessionStructure => {
  const previousRef = React.useRef<GlobalSessionStructure | null>(null);
  return React.useMemo(() => {
    const previous = previousRef.current;
    if (previous && haveSameSidebarHierarchy(previous, structure)) return previous;
    previousRef.current = structure;
    return structure;
  }, [structure]);
};

export const useSessionProjectCollection = ({
  knownDirectories,
  isVSCode,
  isVisible,
  searchActive,
  projectSortOrder,
}: UseSessionProjectCollectionArgs) => {
  const nestedSessionOwners = useSessionUIStore((state) => state.nestedSessionOwners);
  const readsActivityTime = useSidebarReadsActivityTime(searchActive, projectSortOrder);
  const globalActiveSessions = useStructurallyStableSessions(useGlobalSessionsStore((state) => state.activeSessions), readsActivityTime);
  const globalStructure = useStableHierarchy(useGlobalSessionsStore((state) => state.structure));
  const rawArchivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const archivedSessions = React.useMemo(() => {
    const known = new Set([...knownDirectories].map((directory) => isVSCode ? directory.toLowerCase() : directory));
    return rawArchivedSessions.filter((session) => (
      isChatDirectoryPath(session.directory) ? !isVSCode : isKnownActiveSessionDirectory(session, known, isVSCode)
    ));
  }, [isVSCode, knownDirectories, rawArchivedSessions]);
  const hasAuthoritativeGlobalSessions = useGlobalSessionsStore((state) => state.status === 'ready');
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => isVisible ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [isVisible],
  ));
  const globalSessionIds = React.useMemo(
    () => new Set([...globalActiveSessions, ...rawArchivedSessions].map((session) => session.id)),
    [globalActiveSessions, rawArchivedSessions],
  );
  const liveGapSessions = useLiveSessionsExcluding(globalSessionIds);
  const structure = React.useMemo(() => buildSidebarSessionStructure({
    globalActiveSessions,
    globalStructure,
    liveSessions: liveGapSessions,
    knownDirectories,
    isVSCode,
    nestedSessionOwners,
  }), [globalActiveSessions, globalStructure, isVSCode, knownDirectories, liveGapSessions, nestedSessionOwners]);
  const ordering = React.useMemo(
    () => orderSidebarSessionStructure(structure, pinnedSessionIds, sessionOrderRanks),
    [pinnedSessionIds, sessionOrderRanks, structure],
  );
  const { chatSessions, orderedSessions } = ordering;
  const getTimeOrderedSessions = React.useMemo(() => {
    let cached: Session[] | null = null;
    return (): readonly Session[] => {
      if (pinnedSessionIds.size === 0) return orderedSessions;
      cached ??= orderSidebarSessionStructure(structure, EMPTY_PINNED_SESSION_IDS, sessionOrderRanks).orderedSessions;
      return cached;
    };
  }, [orderedSessions, pinnedSessionIds, sessionOrderRanks, structure]);
  const sessionById = React.useMemo(() => new Map(
    [...structure.sessions, ...archivedSessions].map((session) => [session.id, session]),
  ), [archivedSessions, structure.sessions]);
  const childrenMap = React.useMemo(() => {
    const children = new Map(ordering.childrenMap);
    for (const session of archivedSessions) {
      // SAFETY: OpenCode's session records carry parentID for sub-session
      // hierarchy; the SDK's base Session type does not currently expose it.
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) continue;
      const siblings = children.get(parentID) ?? [];
      siblings.push(session);
      children.set(parentID, siblings);
    }
    return children;
  }, [archivedSessions, ordering.childrenMap]);
  const nestedSessionIds = React.useMemo(() => {
    const nested = new Set<string>();
    for (const [parentId, children] of childrenMap) {
      if (!sessionById.has(parentId)) continue;
      for (const child of children) nested.add(child.id);
    }
    return nested;
  }, [childrenMap, sessionById]);
  const projectSessionIds = React.useMemo(
    () => new Set(structure.projectSessions.map((session) => session.id)),
    [structure.projectSessions],
  );
  const sessions = React.useMemo(
    () => orderedSessions.filter((session) => projectSessionIds.has(session.id)),
    [orderedSessions, projectSessionIds],
  );
  const rootSessions = React.useMemo(
    () => sessions.filter((session) => !nestedSessionIds.has(session.id)),
    [nestedSessionIds, sessions],
  );
  const getDescendantIdsForAction = React.useCallback(
    (sessionId: string, options: { includeArchived: boolean }) => getDescendantIds(childrenMap, sessionId)
      .filter((id) => options.includeArchived || !sessionById.get(id)?.time?.archived),
    [childrenMap, sessionById],
  );

  return {
    archivedSessions,
    childrenMap,
    chatSessions,
    getDescendantIds: getDescendantIdsForAction,
    hasAuthoritativeGlobalSessions,
    nestedSessionIds,
    orderedSessions,
    getTimeOrderedSessions,
    pinnedSessionIds,
    sessionOrderRanks,
    sessions,
    rootSessions,
    sessionById,
    nestedSessionOwners,
  };
};
