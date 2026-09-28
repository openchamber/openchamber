import { create } from 'zustand';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { filterManagedChatsForRuntime, listGlobalSessionPages, splitGlobalSessionsByArchived, type SessionPageLister } from '@/stores/globalSessions';
import { getReviewTransferDirection, type ReviewTransferDirection } from '@/lib/reviewFlow';
import { getOriginalSessionID, getReviewSessionID } from '@/lib/sessionReviewMetadata';
import { normalizePath } from '@/lib/pathNormalization';
import { raiseSessionOrderingBaselines } from '@/sync/session-ordering';
import { mapWithConcurrency } from '@/lib/concurrency';
import { persistManagedChatSessions, readManagedChatSessions } from '@/sync/persist-cache';
import { isVSCodeRuntime } from '@/lib/desktop';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useSpacesStore, type SpaceMark } from '@/lib/spaces/spaces-store';
import { ensureChatsRootDirectory, getChatsRootForHome } from '@/lib/chatDirectories';
import { countSyncPerformance } from '@/sync/performance-diagnostics';
import {
  applyGlobalSessionStructureMutations,
  buildGlobalSessionStructure,
  mergeSessionDirectoryMetadata,
  resolveGlobalSessionDirectory,
  type GlobalSessionStructure,
  type GlobalSessionStructureMutation,
} from './globalSessionStructure';

export { mergeSessionDirectoryMetadata, resolveGlobalSessionDirectory } from './globalSessionStructure';

type GlobalSessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

type LoadResult = {
  activeSessions: Session[];
  archivedSessions: Session[];
};

export type GlobalSessionMutation =
  | { type: 'upsert'; session: Session }
  | { type: 'remove'; sessionId: string };

type GlobalSessionsState = {
  activeSessions: Session[];
  archivedSessions: Session[];
  entityById: ReadonlyMap<string, Session>;
  structure: GlobalSessionStructure;
  sessionsByDirectory: Map<string, Session[]>;
  reviewTransferBySessionId: Map<string, ReviewTransferDirection>;
  mutationRevision: number;
  mutationRevisionBySessionId: Map<string, number>;
  /** A complete global snapshot has arrived for this runtime. */
  hasLoaded: boolean;
  managedChatsHydrated: boolean;
  status: GlobalSessionsStatus;
  /** Re-read the persisted managed-chats snapshot after the chats root is
      warm; retain newer mutations and stop after an authoritative load. */
  rehydrateManagedChatSessions: () => void;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  refreshSessionsForDirectories: (directories: Iterable<string>, fallbackActive?: Session[]) => Promise<LoadResult>;
  applySnapshot: (activeSessions: Session[], archivedSessions: Session[], status?: GlobalSessionsStatus) => void;
  applySessionMutations: (mutations: readonly GlobalSessionMutation[]) => void;
  upsertSession: (session: Session) => void;
  upsertSessions: (sessions: Session[]) => void;
  removeSessions: (ids: Iterable<string>) => void;
  archiveSessions: (ids: Iterable<string>, archivedAt?: number) => void;
  /** Drop every session from the previous runtime instance and go back to the
      unloaded state, so a fresh load runs against the new endpoint. */
  resetForRuntimeSwitch: () => void;
};

const PAGE_SIZE = 500;
const DIRECTORY_SESSION_REFRESH_CONCURRENCY = 2;
let directorySessionRefreshActive = 0;
const directorySessionRefreshWaiters: Array<() => void> = [];

const withDirectorySessionRefreshSlot = async <T>(task: () => Promise<T>): Promise<T> => {
  if (directorySessionRefreshActive >= DIRECTORY_SESSION_REFRESH_CONCURRENCY) {
    await new Promise<void>((resolve) => directorySessionRefreshWaiters.push(resolve));
  } else {
    directorySessionRefreshActive += 1;
  }
  try {
    return await task();
  } finally {
    const next = directorySessionRefreshWaiters.shift();
    if (next) next();
    else directorySessionRefreshActive = Math.max(0, directorySessionRefreshActive - 1);
  }
};

let inflightLoad: Promise<LoadResult> | null = null;
// True while a page of an unfinished load is being merged. The managed-chats
// snapshot is written from complete loads only, never from a partial list.
let mergingSessionPage = false;
// Bumped on runtime switch: an in-flight load from the previous instance must
// not apply its (stale) snapshot after the reset.
let loadGeneration = 0;

export const mergeLiveSessionWithGlobalSession = (
  liveSession: Session,
  globalSession: Session,
): Session => mergeSessionDirectoryMetadata(liveSession, globalSession);

const buildSessionsByDirectory = (sessions: Session[]): Map<string, Session[]> => {
  const next = new Map<string, Session[]>();
  for (const session of sessions) {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) {
      continue;
    }
    const existing = next.get(directory);
    if (existing) {
      existing.push(session);
      continue;
    }
    next.set(directory, [session]);
  }
  return next;
};

const getSessionSignature = (session: Session): string => {
  return [
    session.id,
    session.title ?? '',
    session.parentID ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    JSON.stringify(session.metadata ?? null),
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

const getSessionStructuralSignature = (session: Session): string => {
  return [
    session.id,
    session.title ?? '',
    session.parentID ?? '',
    session.time?.created ?? 0,
    session.time?.archived ?? 0,
    JSON.stringify(session.metadata ?? null),
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

export const isGlobalSessionRecencyOnlyUpdate = (existing: Session, incoming: Session): boolean => {
  const merged = mergeSessionDirectoryMetadata(incoming, existing);
  return existing.time?.updated !== merged.time?.updated
    && getSessionStructuralSignature(existing) === getSessionStructuralSignature(merged);
};

const sameSessionList = (prev: Session[], next: Session[]): boolean => {
  if (prev === next) {
    return true;
  }
  if (prev.length !== next.length) {
    return false;
  }
  for (let index = 0; index < prev.length; index += 1) {
    if (getSessionSignature(prev[index]) !== getSessionSignature(next[index])) {
      return false;
    }
  }
  return true;
};

const getSessionUpdatedAt = (session: Session): number => {
  const updatedAt = session.time?.updated;
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = session.time?.created;
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0;
};

const sortSessionsByUpdated = (sessions: Session[]): Session[] => {
  return [...sessions].sort((left, right) => {
    const timeDelta = getSessionUpdatedAt(right) - getSessionUpdatedAt(left);
    if (timeDelta !== 0) return timeDelta;
    return right.id.localeCompare(left.id);
  });
};

const normalizeDirectorySet = (directories: Iterable<string>): Set<string> => {
  const next = new Set<string>();
  for (const directory of directories) {
    const normalized = normalizePath(directory);
    if (normalized) next.add(normalized);
  }
  return next;
};

const replaceSessionsForDirectories = (
  existing: Session[],
  incoming: Session[],
  directories: Set<string>,
): Session[] => {
  if (directories.size === 0) {
    return existing;
  }

  const existingById = new Map(existing.map((session) => [session.id, session]));
  const incomingById = new Map<string, Session>();

  for (const session of incoming) {
    if (!session?.id) continue;
    incomingById.set(session.id, mergeSessionDirectoryMetadata(session, existingById.get(session.id)));
  }

  const kept = existing.filter((session) => {
    if (incomingById.has(session.id)) return false;
    const directory = resolveGlobalSessionDirectory(session);
    return !directory || !directories.has(directory);
  });

  return sortSessionsByUpdated([...incomingById.values(), ...kept]);
};

type DirectoryPageResult = {
  directories: Set<string>;
  sessions: Session[];
  errors: unknown[];
};

/** The session-list transport, bound once so paging code stays testable. */
const listSessionPage: SessionPageLister = (options) => opencodeClient.listSessionsPage(options);

const fetchDirectoryPages = async (
  directories: Set<string>,
): Promise<DirectoryPageResult> => {
  const currentDirectory = normalizePath(opencodeClient.getDirectory());
  const orderedDirectories = [...directories].sort((left, right) => {
    if (left === currentDirectory) return -1;
    if (right === currentDirectory) return 1;
    return left.localeCompare(right);
  });
  const results = await mapWithConcurrency(orderedDirectories, DIRECTORY_SESSION_REFRESH_CONCURRENCY, async (directory) => {
    try {
      return {
        status: 'fulfilled' as const,
        value: {
          directory,
          // One request per directory, split client-side: archive state is
          // OpenChamber's own and the session list has no archived filter.
          sessions: await withDirectorySessionRefreshSlot(() => (
            listGlobalSessionPages(listSessionPage, { directory, pageSize: PAGE_SIZE })
          )),
        },
      };
    } catch (reason) {
      return { status: 'rejected' as const, reason };
    }
  });

  const fulfilledDirectories = new Set<string>();
  const sessions: Session[] = [];
  const errors: unknown[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      fulfilledDirectories.add(result.value.directory);
      sessions.push(...result.value.sessions);
    } else {
      errors.push(result.reason);
    }
  }

  return { directories: fulfilledDirectories, sessions, errors };
};

const upsertSessionIntoList = (sessions: Session[], session: Session): Session[] => {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [session, ...sessions];
  }
  const mergedSession = mergeSessionDirectoryMetadata(session, sessions[index]);
  if (getSessionSignature(sessions[index]) === getSessionSignature(mergedSession)) {
    return sessions;
  }
  const next = [...sessions];
  next[index] = mergedSession;
  return next;
};

const mergeSessionLists = (existing: Session[], incoming?: Session[]): Session[] => {
  if (!incoming || incoming.length === 0) {
    return existing;
  }

  if (existing.length === 0) {
    return incoming;
  }

  const byId = new Map(existing.map((session) => [session.id, session]));
  incoming.forEach((session) => {
    byId.set(session.id, mergeSessionDirectoryMetadata(session, byId.get(session.id)));
  });

  const ordered: Session[] = [];
  const seen = new Set<string>();

  existing.forEach((session) => {
    const next = byId.get(session.id);
    if (!next) {
      return;
    }
    ordered.push(next);
    seen.add(session.id);
  });

  incoming.forEach((session) => {
    if (seen.has(session.id)) {
      return;
    }
    const next = byId.get(session.id);
    if (next) {
      ordered.push(next);
      seen.add(session.id);
    }
  });

  return ordered;
};

const applySnapshot = (
  state: GlobalSessionsState,
  activeSessions: Session[],
  archivedSessions: Session[],
  status: GlobalSessionsStatus,
  /** False for a partial page merged mid-load: the lists are incomplete, so
      they must not claim the authority `hasLoaded` grants. */
  markLoaded = status === 'ready',
): Partial<GlobalSessionsState> | GlobalSessionsState => {
  if (isVSCodeRuntime()) {
    activeSessions = filterManagedChatsForRuntime(activeSessions, true);
    archivedSessions = filterManagedChatsForRuntime(archivedSessions, true);
  }
  const nextActiveSessions = sameSessionList(state.activeSessions, activeSessions)
    ? state.activeSessions
    : activeSessions;
  const nextArchivedSessions = sameSessionList(state.archivedSessions, archivedSessions)
    ? state.archivedSessions
    : archivedSessions;
  const sessionsChanged = nextActiveSessions !== state.activeSessions
    || nextArchivedSessions !== state.archivedSessions;
  const nextEntityById = sessionsChanged
    ? new Map([...nextActiveSessions, ...nextArchivedSessions].map((session) => [session.id, session]))
    : state.entityById;
  const nextStructure = nextActiveSessions !== state.activeSessions
    ? buildGlobalSessionStructure(nextActiveSessions)
    : state.structure;
  const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
    ? state.sessionsByDirectory
    : buildSessionsByDirectory(nextActiveSessions);
  const nextReviewTransferMap = nextActiveSessions === state.activeSessions
    ? state.reviewTransferBySessionId
    : buildReviewTransferMap(nextActiveSessions);

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
    && nextSessionsByDirectory === state.sessionsByDirectory
    && nextReviewTransferMap === state.reviewTransferBySessionId
    && (state.hasLoaded || !markLoaded)
    && state.status === status
  ) {
    return state;
  }

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    entityById: nextEntityById,
    structure: nextStructure,
    sessionsByDirectory: nextSessionsByDirectory,
    reviewTransferBySessionId: nextReviewTransferMap,
    hasLoaded: markLoaded ? true : state.hasLoaded,
    status,
  };
};

/**
 * Merge one page of an in-flight global load into the visible lists. Never a
 * replacement: the store may already hold the persisted managed-chats seed and
 * earlier pages, and those must stay visible while pagination continues.
 * Sessions the page reclassifies move buckets; mutations newer than the load's
 * baseline win, so an archive or delete made while the page was in flight is
 * not undone.
 */
const mergeSessionPage = (
  state: GlobalSessionsState,
  active: Session[],
  archived: Session[],
  baselineRevision: number,
): Partial<GlobalSessionsState> | GlobalSessionsState => {
  const incomingActiveIds = new Set(active.map((session) => session.id));
  const incomingArchivedIds = new Set(archived.map((session) => session.id));
  const mergedActive = mergeSessionLists(state.activeSessions, active)
    .filter((session) => !incomingArchivedIds.has(session.id));
  const mergedArchived = mergeSessionLists(state.archivedSessions, archived)
    .filter((session) => !incomingActiveIds.has(session.id));
  const reconciled = overlayMutationsSince(state, mergedActive, mergedArchived, baselineRevision);
  return applySnapshot(state, reconciled.activeSessions, reconciled.archivedSessions, state.status, false);
};

const overlayMutationsSince = (
  state: GlobalSessionsState,
  activeSessions: Session[],
  archivedSessions: Session[],
  baselineRevision: number,
): LoadResult => {
  const affectedIds = new Set<string>();
  for (const [sessionId, revision] of state.mutationRevisionBySessionId) {
    if (revision > baselineRevision) affectedIds.add(sessionId);
  }
  if (affectedIds.size === 0) return { activeSessions, archivedSessions };

  const currentActive = new Map(state.activeSessions.map((session) => [session.id, session]));
  const currentArchived = new Map(state.archivedSessions.map((session) => [session.id, session]));
  let nextActive = activeSessions.filter((session) => !affectedIds.has(session.id));
  let nextArchived = archivedSessions.filter((session) => !affectedIds.has(session.id));
  for (const sessionId of affectedIds) {
    const active = currentActive.get(sessionId);
    const archived = currentArchived.get(sessionId);
    if (active) nextActive = upsertSessionIntoList(nextActive, active);
    else if (archived) nextArchived = upsertSessionIntoList(nextArchived, archived);
  }
  return { activeSessions: nextActive, archivedSessions: nextArchived };
};

const mutationRevisionPatch = (state: GlobalSessionsState, ids: Iterable<string>) => {
  const mutationRevision = state.mutationRevision + 1;
  const mutationRevisionBySessionId = new Map(state.mutationRevisionBySessionId);
  for (const id of ids) mutationRevisionBySessionId.set(id, mutationRevision);
  return { mutationRevision, mutationRevisionBySessionId };
};

const materializeChangedSessionList = (
  previous: readonly Session[],
  memberIds: ReadonlySet<string>,
  additions: ReadonlySet<string>,
  entityById: ReadonlyMap<string, Session>,
): Session[] => {
  const additionsInDisplayOrder = [...additions].reverse();
  const addedIds = new Set(additionsInDisplayOrder);
  const next = additionsInDisplayOrder.flatMap((sessionId) => {
    const session = entityById.get(sessionId);
    return session && memberIds.has(sessionId) ? [session] : [];
  });
  for (const previousSession of previous) {
    if (!memberIds.has(previousSession.id) || addedIds.has(previousSession.id)) continue;
    const session = entityById.get(previousSession.id);
    if (session) next.push(session);
  }
  return next;
};

const updateSessionsByDirectory = (
  previous: Map<string, Session[]>,
  previousStructure: GlobalSessionStructure,
  nextStructure: GlobalSessionStructure,
  entityById: ReadonlyMap<string, Session>,
  mutations: readonly GlobalSessionStructureMutation[],
): Map<string, Session[]> => {
  const affectedDirectories = new Set<string>();
  const entityChangedDirectories = new Set<string>();
  for (const mutation of mutations) {
    const previousDirectory = mutation.previous && !mutation.previous.time?.archived
      ? resolveGlobalSessionDirectory(mutation.previous)
      : null;
    const nextDirectory = mutation.next && !mutation.next.time?.archived
      ? resolveGlobalSessionDirectory(mutation.next)
      : null;
    if (previousDirectory) affectedDirectories.add(previousDirectory);
    if (nextDirectory) {
      affectedDirectories.add(nextDirectory);
      entityChangedDirectories.add(nextDirectory);
    }
  }
  if (affectedDirectories.size === 0) return previous;

  let next: Map<string, Session[]> | null = null;
  for (const directory of affectedDirectories) {
    const previousIds = previousStructure.activeIdsByDirectory.get(directory);
    const nextIds = nextStructure.activeIdsByDirectory.get(directory);
    if (previousIds === nextIds && !entityChangedDirectories.has(directory)) continue;
    next ??= new Map(previous);
    if (!nextIds || nextIds.length === 0) {
      next.delete(directory);
      continue;
    }
    next.set(directory, nextIds.flatMap((sessionId) => {
      const session = entityById.get(sessionId);
      return session ? [session] : [];
    }));
  }
  return next ?? previous;
};

const applySessionMutations = (
  state: GlobalSessionsState,
  requestedMutations: readonly GlobalSessionMutation[],
): Partial<GlobalSessionsState> => {
  let mutations = requestedMutations;
  if (isVSCodeRuntime()) {
    mutations = requestedMutations.filter((mutation) => (
      mutation.type === 'remove'
      || filterManagedChatsForRuntime([mutation.session], true).length > 0
    ));
    if (mutations.length === 0) return state;
  }
  const revisionPatch = mutationRevisionPatch(state, mutations.map((mutation) => (
    mutation.type === 'upsert' ? mutation.session.id : mutation.sessionId
  )));
  let nextEntityById: Map<string, Session> | null = null;
  const activeIds = new Set(state.activeSessions.map((session) => session.id));
  const archivedIds = new Set(state.archivedSessions.map((session) => session.id));
  const activeAdditions = new Set<string>();
  const archivedAdditions = new Set<string>();
  const structureMutations: GlobalSessionStructureMutation[] = [];
  let activeChanged = false;
  let archivedChanged = false;

  const addMember = (ids: Set<string>, additions: Set<string>, sessionId: string): void => {
    if (ids.has(sessionId)) return;
    ids.add(sessionId);
    additions.delete(sessionId);
    additions.add(sessionId);
  };
  const removeMember = (ids: Set<string>, additions: Set<string>, sessionId: string): void => {
    ids.delete(sessionId);
    additions.delete(sessionId);
  };

  for (const mutation of mutations) {
    const sessionId = mutation.type === 'upsert' ? mutation.session.id : mutation.sessionId;
    const existingSession = (nextEntityById ?? state.entityById).get(sessionId) ?? null;
    if (mutation.type === 'remove') {
      if (!existingSession) continue;
      nextEntityById ??= new Map(state.entityById);
      nextEntityById.delete(sessionId);
      structureMutations.push({ sessionId, previous: existingSession, next: null });
      if (existingSession.time?.archived) {
        archivedChanged = true;
        removeMember(archivedIds, archivedAdditions, sessionId);
      } else {
        activeChanged = true;
        removeMember(activeIds, activeAdditions, sessionId);
      }
      continue;
    }

    const sessionWithMetadata = mergeSessionDirectoryMetadata(mutation.session, existingSession);
    if (existingSession && getSessionSignature(existingSession) === getSessionSignature(sessionWithMetadata)) continue;
    nextEntityById ??= new Map(state.entityById);
    nextEntityById.set(sessionId, sessionWithMetadata);
    structureMutations.push({ sessionId, previous: existingSession, next: sessionWithMetadata });
    const isArchived = Boolean(sessionWithMetadata.time?.archived);
    const wasArchived = Boolean(existingSession?.time?.archived);
    if (existingSession) {
      if (wasArchived) archivedChanged = true;
      else activeChanged = true;
    }
    if (isArchived) {
      archivedChanged = true;
      removeMember(activeIds, activeAdditions, sessionId);
      addMember(archivedIds, archivedAdditions, sessionId);
    } else {
      activeChanged = true;
      removeMember(archivedIds, archivedAdditions, sessionId);
      addMember(activeIds, activeAdditions, sessionId);
    }
  }

  if (!nextEntityById) {
    return revisionPatch;
  }
  const nextActiveSessions = activeChanged
    ? materializeChangedSessionList(state.activeSessions, activeIds, activeAdditions, nextEntityById)
    : state.activeSessions;
  const nextArchivedSessions = archivedChanged
    ? materializeChangedSessionList(state.archivedSessions, archivedIds, archivedAdditions, nextEntityById)
    : state.archivedSessions;
  const nextStructure = applyGlobalSessionStructureMutations(state.structure, structureMutations);

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    entityById: nextEntityById,
    structure: nextStructure,
    sessionsByDirectory: updateSessionsByDirectory(
      state.sessionsByDirectory,
      state.structure,
      nextStructure,
      nextEntityById,
      structureMutations,
    ),
    reviewTransferBySessionId: nextActiveSessions === state.activeSessions
      ? state.reviewTransferBySessionId
      : buildReviewTransferMap(nextActiveSessions),
    ...revisionPatch,
  };
};

const buildReviewTransferMap = (sessions: Session[]): Map<string, ReviewTransferDirection> => {
  const next = new Map<string, ReviewTransferDirection>()
  const activeIds = new Set(sessions.map((s) => s.id))
  for (const session of sessions) {
    const direction = getReviewTransferDirection(session)
    if (!direction) continue
    const targetSessionId = direction === 'review-to-original'
      ? getOriginalSessionID(session)
      : getReviewSessionID(session)
    if (!targetSessionId || !activeIds.has(targetSessionId)) continue
    next.set(session.id, direction)
  }
  return next
}

const buildManagedChatSessionsState = (sessions: Session[], archivedSessions: Session[] = []) => ({
  activeSessions: sessions,
  archivedSessions,
  entityById: new Map([...sessions, ...archivedSessions].map((session) => [session.id, session])),
  structure: buildGlobalSessionStructure(sessions),
  sessionsByDirectory: buildSessionsByDirectory(sessions),
  reviewTransferBySessionId: buildReviewTransferMap(sessions),
});

const initialManagedChatSessions = readManagedChatSessions();
const initialState = buildManagedChatSessionsState(initialManagedChatSessions);

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => ({
  ...initialState,
  mutationRevision: 0,
  mutationRevisionBySessionId: new Map(),
  hasLoaded: false,
  managedChatsHydrated: false,
  status: 'idle',

  applySnapshot: (activeSessions, archivedSessions, status = 'ready') => {
    // An authoritative snapshot may carry newer `updated` stamps for sessions
    // whose active→settled cycle this client slept through — raise their
    // ordering baselines so recent lists re-sort (see session-ordering).
    raiseSessionOrderingBaselines(activeSessions);
    set((state) => applySnapshot(state, activeSessions, archivedSessions, status));
  },

  applySessionMutations: (mutations) => {
    if (mutations.length === 0) return;
    set((state) => applySessionMutations(state, mutations));
  },

  // The module-init seed and runtime reset read the persisted snapshot before
  // the server-resolved chats root is available, so relocated directories are
  // filtered out of the stale sidebar paint until this runs after the warm-up.
  rehydrateManagedChatSessions: () => {
    const state = get();
    if (state.managedChatsHydrated || state.hasLoaded) return;
    const hydrated = overlayMutationsSince(state, readManagedChatSessions(), state.archivedSessions, 0);
    const unchanged = sameSessionList(hydrated.activeSessions, state.activeSessions)
      && sameSessionList(hydrated.archivedSessions, state.archivedSessions);
    set(unchanged
      ? { managedChatsHydrated: true }
      : { ...buildManagedChatSessionsState(hydrated.activeSessions, hydrated.archivedSessions), managedChatsHydrated: true });
  },

  resetForRuntimeSwitch: () => {
    loadGeneration += 1;
    inflightLoad = null;
    set({
      ...buildManagedChatSessionsState(readManagedChatSessions()),
      mutationRevision: 0,
      mutationRevisionBySessionId: new Map(),
      hasLoaded: false,
      managedChatsHydrated: false,
      status: 'idle',
    });
  },

  loadSessions: async (fallbackActive) => {
    if (inflightLoad) {
      return inflightLoad;
    }

    const generation = loadGeneration;
    const baselineRevision = get().mutationRevision;
    const loadPromise = (async () => {
      let rootsReady = false;
      try {
        await ensureChatsRootDirectory();
        if (generation !== loadGeneration) return { activeSessions: [], archivedSessions: [] };
        rootsReady = true;
        get().rehydrateManagedChatSessions();
        // One fetch of every session, split client-side: archive state is
        // OpenChamber's own, so the server list cannot filter on it.
        // Thousands of sessions paginate for seconds. Show the newest page as
        // soon as it lands and keep loading the rest silently; the complete
        // snapshot below is still the only authoritative result.
        let firstPageMerged = false;
        // The marks of the isolated spaces the host merged in, applied with the snapshot below.
        let spaceMarks: SpaceMark[] = [];
        const allSessions = await listGlobalSessionPages(listSessionPage, {
          pageSize: PAGE_SIZE,
          onSpaces: (spaces) => { spaceMarks = spaces ?? []; },
          onPage: (page) => {
            if (firstPageMerged || generation !== loadGeneration) return;
            firstPageMerged = true;
            const firstPage = splitGlobalSessionsByArchived(page);
            mergingSessionPage = true;
            try {
              set((state) => mergeSessionPage(state, firstPage.active, firstPage.archived, baselineRevision));
            } finally {
              mergingSessionPage = false;
            }
          },
        });

        if (generation !== loadGeneration) {
          // Runtime switched mid-load: this snapshot belongs to the previous
          // instance — drop it.
          return { activeSessions: [], archivedSessions: [] };
        }
        const { active, archived } = splitGlobalSessionsByArchived(allSessions);
        // The marks first: a reader of the snapshot that asks which space a record belongs to
        // must find the space that listed it.
        useSpacesStore.getState().applyMarks(spaceMarks);
        set((state) => {
          const reconciled = overlayMutationsSince(state, active, archived, baselineRevision);
          return applySnapshot(state, reconciled.activeSessions, reconciled.archivedSessions, 'ready');
        });
        const committed = get();
        raiseSessionOrderingBaselines(committed.activeSessions);
        return { activeSessions: committed.activeSessions, archivedSessions: committed.archivedSessions };
      } catch (error) {
        if (generation !== loadGeneration) {
          return { activeSessions: [], archivedSessions: [] };
        }
        if (!rootsReady) {
          // No classification authority arrived. Preserve both memory and the
          // persisted snapshot so a retry can hydrate it after root recovery.
          set({ status: 'error' });
          const state = get();
          return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
        }
        console.warn('[GlobalSessions] Failed to load sessions, using fallback snapshot:', error);
        set((state) => {
          const reconciled = overlayMutationsSince(
            state,
            mergeSessionLists(state.activeSessions, fallbackActive),
            state.archivedSessions,
            baselineRevision,
          );
          return applySnapshot(state, reconciled.activeSessions, reconciled.archivedSessions, 'error');
        });
        const committed = get();
        return { activeSessions: committed.activeSessions, archivedSessions: committed.archivedSessions };
      }
    })();

    inflightLoad = loadPromise;
    set({ status: 'loading' });
    const clearInflightLoad = () => {
      if (inflightLoad === loadPromise) {
        inflightLoad = null;
      }
    };
    void loadPromise.then(clearInflightLoad, clearInflightLoad);
    return loadPromise;
  },

  refreshSessionsForDirectories: async (directories, fallbackActive) => {
    const directorySet = normalizeDirectorySet(directories);
    if (directorySet.size === 0) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }

    const generation = loadGeneration;
    const baselineRevision = get().mutationRevision;
    try {
      await ensureChatsRootDirectory();
    } catch {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }
    if (generation !== loadGeneration) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }
    get().rehydrateManagedChatSessions();
    const fetched = await fetchDirectoryPages(directorySet);

    if (generation !== loadGeneration) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }

    if (fetched.errors.length > 0) {
      console.warn('[GlobalSessions] Failed to refresh sessions for some directories:', fetched.errors[0]);
    }
    // A space that answered a directory read is reachable again, whatever the last global list said.
    for (const directory of fetched.directories) {
      const spaceId = spaceIdOfDirectory(directory);
      if (spaceId !== null) useSpacesStore.getState().noteReachable(spaceId);
    }

    const { active, archived } = splitGlobalSessionsByArchived(fetched.sessions);
    const refreshedActiveIds = active.map((session) => session.id);

    set((state) => {
      let nextActiveSessions = replaceSessionsForDirectories(state.activeSessions, active, fetched.directories);
      nextActiveSessions = mergeSessionLists(nextActiveSessions, fallbackActive);
      if (sameSessionList(state.activeSessions, nextActiveSessions)) {
        nextActiveSessions = state.activeSessions;
      }

      let nextArchivedSessions = replaceSessionsForDirectories(state.archivedSessions, archived, fetched.directories);
      if (sameSessionList(state.archivedSessions, nextArchivedSessions)) {
        nextArchivedSessions = state.archivedSessions;
      }

      const reconciled = overlayMutationsSince(state, nextActiveSessions, nextArchivedSessions, baselineRevision);
      nextActiveSessions = reconciled.activeSessions;
      nextArchivedSessions = reconciled.archivedSessions;

      const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
        ? state.sessionsByDirectory
        : buildSessionsByDirectory(nextActiveSessions);
      const activeChanged = nextActiveSessions !== state.activeSessions;
      const archivedChanged = nextArchivedSessions !== state.archivedSessions;

      if (
        !activeChanged
        && !archivedChanged
        && nextSessionsByDirectory === state.sessionsByDirectory
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        entityById: new Map([...nextActiveSessions, ...nextArchivedSessions].map((session) => [session.id, session])),
        structure: activeChanged ? buildGlobalSessionStructure(nextActiveSessions) : state.structure,
        sessionsByDirectory: nextSessionsByDirectory,
        reviewTransferBySessionId: nextActiveSessions === state.activeSessions
          ? state.reviewTransferBySessionId
          : buildReviewTransferMap(nextActiveSessions),
      };
    });

    const state = get();
    raiseSessionOrderingBaselines(refreshedActiveIds.flatMap((sessionId) => {
      const session = state.entityById.get(sessionId);
      return session && !session.time?.archived ? [session] : [];
    }));
    return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
  },

  upsertSession: (session) => {
    set((state) => applySessionMutations(state, [{ type: 'upsert', session }]));
  },

  upsertSessions: (sessions) => {
    if (sessions.length === 0) return;
    set((state) => applySessionMutations(
      state,
      sessions.map((session) => ({ type: 'upsert' as const, session })),
    ));
  },

  removeSessions: (ids) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => applySessionMutations(
      state,
      [...idSet].map((sessionId) => ({ type: 'remove' as const, sessionId })),
    ));
  },

  archiveSessions: (ids, archivedAt = Date.now()) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const movedSessions: Session[] = [];
      for (const sessionId of idSet) {
        const session = state.entityById.get(sessionId);
        if (!session || session.time?.archived) continue;
        movedSessions.push({
          ...session,
          time: {
            ...session.time,
            archived: archivedAt,
          },
        });
      }

      if (movedSessions.length === 0) {
        return mutationRevisionPatch(state, idSet);
      }
      const patch = applySessionMutations(
        state,
        movedSessions.map((session) => ({ type: 'upsert' as const, session })),
      );
      return {
        ...patch,
        ...mutationRevisionPatch(state, idSet),
      };
    });
  },
}));

useGlobalSessionsStore.subscribe((state, previous) => {
  countSyncPerformance('globalSessionPublications');
  if (
    !mergingSessionPage
    && getChatsRootForHome(null) !== null
    && (state.activeSessions !== previous.activeSessions
      || (!state.managedChatsHydrated && state.mutationRevision !== previous.mutationRevision)
      || (state.hasLoaded && !previous.hasLoaded))
  ) {
    // A local mutation can precede the initial load. Preserve the saved seed
    // and overlay its explicit mutations instead of persisting a partial list.
    const sessions = !state.hasLoaded && !state.managedChatsHydrated
      ? overlayMutationsSince(state, readManagedChatSessions(), [], 0).activeSessions
      : state.activeSessions;
    persistManagedChatSessions(sessions);
  }
});

export const ensureGlobalSessionsLoaded = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  const state = useGlobalSessionsStore.getState();
  if (state.hasLoaded && state.status !== 'error') {
    return {
      activeSessions: state.activeSessions,
      archivedSessions: state.archivedSessions,
    };
  }
  return state.loadSessions(fallbackActive);
};

export const refreshGlobalSessions = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().loadSessions(fallbackActive);
};

export const refreshGlobalSessionsForDirectories = async (
  directories: Iterable<string>,
  fallbackActive?: Session[],
): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().refreshSessionsForDirectories(directories, fallbackActive);
};
