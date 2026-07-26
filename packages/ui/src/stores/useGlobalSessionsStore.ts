import { create } from 'zustand';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { listGlobalSessionPages } from '@/stores/globalSessions';
import { getReviewTransferDirection, type ReviewTransferDirection } from '@/lib/reviewFlow';
import { getOriginalSessionID, getReviewSessionID } from '@/lib/sessionReviewMetadata';
import { normalizePath } from '@/lib/pathNormalization';
import { mapWithConcurrency } from '@/lib/concurrency';

type GlobalSessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

type LoadResult = {
  activeSessions: Session[];
  archivedSessions: Session[];
};

type GlobalSessionsState = {
  activeSessions: Session[];
  archivedSessions: Session[];
  sessionsByDirectory: Map<string, Session[]>;
  reviewTransferBySessionId: Map<string, ReviewTransferDirection>;
  mutationRevision: number;
  mutationRevisionBySessionId: Map<string, number>;
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  refreshSessionsForDirectories: (directories: Iterable<string>, fallbackActive?: Session[]) => Promise<LoadResult>;
  applySnapshot: (activeSessions: Session[], archivedSessions: Session[], status?: GlobalSessionsStatus) => void;
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

export const resolveGlobalSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };

  return normalizePath(record.directory ?? null)
    ?? normalizePath(record.project?.worktree ?? null);
};

export const mergeSessionDirectoryMetadata = (incoming: Session, existing?: Session | null): Session => {
  if (!existing) {
    return incoming;
  }

  const incomingRecord = incoming as Session & {
    directory?: string | null;
    project?: ({ worktree?: string | null } & Record<string, unknown>) | null;
  };
  const existingRecord = existing as Session & {
    directory?: string | null;
    project?: ({ worktree?: string | null } & Record<string, unknown>) | null;
  };

  const incomingDirectory = normalizePath(incomingRecord.directory ?? null);
  const incomingWorktree = normalizePath(incomingRecord.project?.worktree ?? null);
  const existingDirectory = normalizePath(existingRecord.directory ?? null);
  const existingWorktree = normalizePath(existingRecord.project?.worktree ?? null);

  let changed = false;
  const next: typeof incomingRecord = { ...incomingRecord };

  // Some live session updates omit stable raw directory metadata; keep the
  // cached value so project grouping does not temporarily lose the session.
  if (!incomingDirectory && existingDirectory) {
    next.directory = existingRecord.directory;
    changed = true;
  }

  if (!incomingWorktree && existingWorktree) {
    next.project = {
      ...(existingRecord.project ?? {}),
      ...(incomingRecord.project ?? {}),
      worktree: existingRecord.project?.worktree,
    };
    changed = true;
  } else if (!incomingRecord.project && existingRecord.project) {
    next.project = existingRecord.project;
    changed = true;
  }

  return changed ? next : incoming;
};

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
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    session.share?.url ?? '',
    JSON.stringify((session as Session & { metadata?: unknown }).metadata ?? null),
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

export const getSessionStructuralSignature = (session: Session): string => {
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
  archived: boolean,
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
          sessions: await withDirectorySessionRefreshSlot(() => (
            listGlobalSessionPages(sdk, { directory, archived, pageSize: PAGE_SIZE })
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

const removeSessionFromList = (sessions: Session[], sessionId: string): Session[] => {
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) {
    return sessions;
  }
  return [...sessions.slice(0, index), ...sessions.slice(index + 1)];
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
  const nextActiveSessions = sameSessionList(state.activeSessions, activeSessions)
    ? state.activeSessions
    : activeSessions;
  const nextArchivedSessions = sameSessionList(state.archivedSessions, archivedSessions)
    ? state.archivedSessions
    : archivedSessions;
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

const applySessionUpserts = (state: GlobalSessionsState, sessions: Session[]): Partial<GlobalSessionsState> => {
  const revisionPatch = mutationRevisionPatch(state, sessions.map((session) => session.id));
  let nextActiveSessions = state.activeSessions;
  let nextArchivedSessions = state.archivedSessions;

  for (const session of sessions) {
    const existingSession = nextActiveSessions.find((candidate) => candidate.id === session.id)
      ?? nextArchivedSessions.find((candidate) => candidate.id === session.id)
      ?? null;
    const sessionWithMetadata = mergeSessionDirectoryMetadata(session, existingSession);
    const isArchived = Boolean(sessionWithMetadata.time?.archived);
    nextActiveSessions = isArchived
      ? removeSessionFromList(nextActiveSessions, session.id)
      : upsertSessionIntoList(nextActiveSessions, sessionWithMetadata);
    nextArchivedSessions = isArchived
      ? upsertSessionIntoList(nextArchivedSessions, sessionWithMetadata)
      : removeSessionFromList(nextArchivedSessions, session.id);
  }

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
  ) {
    return revisionPatch;
  }

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    sessionsByDirectory: nextActiveSessions === state.activeSessions
      ? state.sessionsByDirectory
      : buildSessionsByDirectory(nextActiveSessions),
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

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => ({
  activeSessions: [],
  archivedSessions: [],
  sessionsByDirectory: new Map(),
  reviewTransferBySessionId: new Map(),
  mutationRevision: 0,
  mutationRevisionBySessionId: new Map(),
  hasLoaded: false,
  status: 'idle',

  applySnapshot: (activeSessions, archivedSessions, status = 'ready') => {
    set((state) => applySnapshot(state, activeSessions, archivedSessions, status));
  },

  resetForRuntimeSwitch: () => {
    loadGeneration += 1;
    inflightLoad = null;
    set({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      reviewTransferBySessionId: new Map(),
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
        const [activeResult, archivedResult] = await Promise.allSettled([
          listGlobalSessionPages(sdk, { archived: false, pageSize: PAGE_SIZE }),
          listGlobalSessionPages(sdk, { archived: true, pageSize: PAGE_SIZE }),
        ]);

        if (activeResult.status === 'rejected') {
          console.warn('[GlobalSessions] Failed to load active sessions, preserving existing snapshot with fallback merge:', activeResult.reason);
        }
        if (archivedResult.status === 'rejected') {
          console.warn('[GlobalSessions] Failed to load archived sessions, preserving current snapshot:', archivedResult.reason);
        }

        if (generation !== loadGeneration) {
          // Runtime switched mid-load: this snapshot belongs to the previous
          // instance — drop it.
          return { activeSessions: [], archivedSessions: [] };
        }
        const status = activeResult.status === 'fulfilled' && archivedResult.status === 'fulfilled'
          ? 'ready'
          : 'error';
        set((state) => {
          const fetchedActive = activeResult.status === 'fulfilled'
            ? activeResult.value
            : mergeSessionLists(state.activeSessions, fallbackActive);
          const fetchedArchived = archivedResult.status === 'fulfilled'
            ? archivedResult.value
            : state.archivedSessions;
          const reconciled = overlayMutationsSince(state, fetchedActive, fetchedArchived, baselineRevision);
          return applySnapshot(state, reconciled.activeSessions, reconciled.archivedSessions, status);
        });
        const committed = get();
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
    const [active, archived] = await Promise.all([
      fetchDirectoryPages(sdk, directorySet, false),
      fetchDirectoryPages(sdk, directorySet, true),
    ]);

    if (generation !== loadGeneration) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }

    if (active.errors.length > 0) {
      console.warn('[GlobalSessions] Failed to refresh active sessions for some directories:', active.errors[0]);
    }
    if (archived.errors.length > 0) {
      console.warn('[GlobalSessions] Failed to refresh archived sessions for some directories:', archived.errors[0]);
    }

    set((state) => {
      let nextActiveSessions = replaceSessionsForDirectories(state.activeSessions, active.sessions, active.directories);
      nextActiveSessions = mergeSessionLists(nextActiveSessions, fallbackActive);
      if (sameSessionList(state.activeSessions, nextActiveSessions)) {
        nextActiveSessions = state.activeSessions;
      }

      let nextArchivedSessions = replaceSessionsForDirectories(state.archivedSessions, archived.sessions, archived.directories);
      if (sameSessionList(state.archivedSessions, nextArchivedSessions)) {
        nextArchivedSessions = state.archivedSessions;
      }

      const reconciled = overlayMutationsSince(state, nextActiveSessions, nextArchivedSessions, baselineRevision);
      nextActiveSessions = reconciled.activeSessions;
      nextArchivedSessions = reconciled.archivedSessions;

      const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
        ? state.sessionsByDirectory
        : buildSessionsByDirectory(nextActiveSessions);

      if (
        nextActiveSessions === state.activeSessions
        && nextArchivedSessions === state.archivedSessions
        && nextSessionsByDirectory === state.sessionsByDirectory
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: nextSessionsByDirectory,
        reviewTransferBySessionId: nextActiveSessions === state.activeSessions
          ? state.reviewTransferBySessionId
          : buildReviewTransferMap(nextActiveSessions),
      };
    });

    const state = get();
    return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
  },

  upsertSession: (session) => {
    set((state) => applySessionUpserts(state, [session]));
  },

  upsertSessions: (sessions) => {
    if (sessions.length === 0) return;
    set((state) => applySessionUpserts(state, sessions));
  },

  removeSessions: (ids) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const revisionPatch = mutationRevisionPatch(state, idSet);
      const nextActiveSessions = state.activeSessions.filter((session) => !idSet.has(session.id));
      const nextArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      if (
        nextActiveSessions.length === state.activeSessions.length
        && nextArchivedSessions.length === state.archivedSessions.length
      ) {
        return revisionPatch;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
        ...revisionPatch,
      };
    });
  },

  archiveSessions: (ids, archivedAt = Date.now()) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const revisionPatch = mutationRevisionPatch(state, idSet);
      const movedSessions: Session[] = [];
      const nextActiveSessions = state.activeSessions.filter((session) => {
        if (!idSet.has(session.id)) {
          return true;
        }

        movedSessions.push({
          ...session,
          time: {
            ...session.time,
            archived: archivedAt,
          },
        });
        return false;
      });

      if (movedSessions.length === 0) {
        return revisionPatch;
      }

      const remainingArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: [...movedSessions, ...remainingArchivedSessions],
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
        ...revisionPatch,
      };
    });
  },
}));

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
