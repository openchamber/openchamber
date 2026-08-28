import { create } from 'zustand';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { filterManagedChatsForRuntime, listGlobalSessionPages, splitGlobalSessionsByArchived } from '@/stores/globalSessions';
import { getReviewTransferDirection, type ReviewTransferDirection } from '@/lib/reviewFlow';
import { getOriginalSessionID, getReviewSessionID } from '@/lib/sessionReviewMetadata';
import { normalizePath } from '@/lib/pathNormalization';
import { raiseSessionOrderingBaselines } from '@/sync/session-ordering';
import { mapWithConcurrency } from '@/lib/concurrency';
import { persistManagedChatSessions, readManagedChatSessions } from '@/sync/persist-cache';
import { isVSCodeRuntime } from '@/lib/desktop';
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
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
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
// Bumped on runtime switch: an in-flight load from the previous instance must
// not apply its (stale) snapshot after the reset.
let loadGeneration = 0;

export const mergeLiveSessionWithGlobalSession = (
  liveSession: Session,
  globalSession: Session,
): Session => {
  const merged = mergeSessionDirectoryMetadata(liveSession, globalSession);
  if (merged.share !== globalSession.share) {
    return { ...merged, share: globalSession.share };
  }
  return merged;
};

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
  const record = session as Session & { parentID?: string | null; slug?: string | null };
  return [
    session.id,
    session.title ?? '',
    record.parentID ?? '',
    record.slug ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    session.share?.url ?? '',
    JSON.stringify((session as Session & { metadata?: unknown }).metadata ?? null),
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

const getSessionStructuralSignature = (session: Session): string => {
  const record = session as Session & { parentID?: string | null; slug?: string | null };
  return [
    session.id,
    session.title ?? '',
    record.parentID ?? '',
    record.slug ?? '',
    session.time?.created ?? 0,
    session.time?.archived ?? 0,
    session.share?.url ?? '',
    JSON.stringify((session as Session & { metadata?: unknown }).metadata ?? null),
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

const fetchDirectoryPages = async (
  sdk: OpencodeClient,
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
          // One inclusive request per directory: the server has no filter that
          // returns only active sessions including restored (`time.archived`
          // falsy-but-present) rows, so fetch everything and split client-side.
          sessions: await withDirectorySessionRefreshSlot(() => (
            listGlobalSessionPages(sdk, { directory, archived: true, narrowToArchived: false, pageSize: PAGE_SIZE })
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
    && state.hasLoaded
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
    hasLoaded: true,
    status,
  };
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

const initialManagedChatSessions = readManagedChatSessions();
const initialEntityById = new Map(initialManagedChatSessions.map((session) => [session.id, session]));
const initialStructure = buildGlobalSessionStructure(initialManagedChatSessions);

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => ({
  activeSessions: initialManagedChatSessions,
  archivedSessions: [],
  entityById: initialEntityById,
  structure: initialStructure,
  sessionsByDirectory: buildSessionsByDirectory(initialManagedChatSessions),
  reviewTransferBySessionId: buildReviewTransferMap(initialManagedChatSessions),
  mutationRevision: 0,
  mutationRevisionBySessionId: new Map(),
  hasLoaded: false,
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

  resetForRuntimeSwitch: () => {
    loadGeneration += 1;
    inflightLoad = null;
    const managedChatSessions = readManagedChatSessions();
    const entityById = new Map(managedChatSessions.map((session) => [session.id, session]));
    set({
      activeSessions: managedChatSessions,
      archivedSessions: [],
      entityById,
      structure: buildGlobalSessionStructure(managedChatSessions),
      sessionsByDirectory: buildSessionsByDirectory(managedChatSessions),
      reviewTransferBySessionId: buildReviewTransferMap(managedChatSessions),
      mutationRevision: 0,
      mutationRevisionBySessionId: new Map(),
      hasLoaded: false,
      status: 'idle',
    });
  },

  loadSessions: async (fallbackActive) => {
    if (inflightLoad) {
      return inflightLoad;
    }

    set((state) => (state.status === 'loading' ? state : { status: 'loading' }));

    const generation = loadGeneration;
    const baselineRevision = get().mutationRevision;
    const loadPromise = (async () => {
      try {
        const sdk = opencodeClient.getSdkClient();
        // One inclusive fetch, split client-side. The server's
        // `time_archived IS NULL` active filter would exclude restored
        // sessions (`time.archived` falsy-but-present), so an
        // `archived: false` request cannot produce a truthful active list.
        const allSessions = await listGlobalSessionPages(sdk, {
          archived: true,
          narrowToArchived: false,
          pageSize: PAGE_SIZE,
        });

        if (generation !== loadGeneration) {
          // Runtime switched mid-load: this snapshot belongs to the previous
          // instance — drop it.
          return { activeSessions: [], archivedSessions: [] };
        }
        const { active, archived } = splitGlobalSessionsByArchived(allSessions);
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
    const sdk = opencodeClient.getSdkClient();
    const fetched = await fetchDirectoryPages(sdk, directorySet);

    if (generation !== loadGeneration) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }

    if (fetched.errors.length > 0) {
      console.warn('[GlobalSessions] Failed to refresh sessions for some directories:', fetched.errors[0]);
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
    state.activeSessions !== previous.activeSessions
    && (state.status !== 'idle' || state.activeSessions.length > 0)
  ) {
    persistManagedChatSessions(state.activeSessions);
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
