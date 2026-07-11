import { create } from 'zustand';
import type { Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { listGlobalSessionPages } from '@/stores/globalSessions';
import { getReviewTransferDirection, type ReviewTransferDirection } from '@/lib/reviewFlow';
import { getOriginalSessionID, getReviewSessionID } from '@/lib/sessionReviewMetadata';

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
  /** Directories that have completed at least one successful per-directory refresh. */
  loadedDirectories: Set<string>;
  /** Directories with an in-flight per-directory session.list refresh. */
  loadingDirectories: Set<string>;
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  refreshSessionsForDirectories: (directories: Iterable<string>, fallbackActive?: Session[]) => Promise<LoadResult>;
  applySnapshot: (activeSessions: Session[], archivedSessions: Session[], status?: GlobalSessionsStatus) => void;
  upsertSession: (session: Session) => void;
  removeSessions: (ids: Iterable<string>) => void;
  archiveSessions: (ids: Iterable<string>, archivedAt?: number) => void;
  /** Drop every session from the previous runtime instance and go back to the
      unloaded state, so a fresh load runs against the new endpoint. */
  resetForRuntimeSwitch: () => void;
};

const PAGE_SIZE = 500;
/** Cap concurrent per-directory session.list fanout so OpenCode stays responsive for create/send. */
const DIRECTORY_FETCH_CONCURRENCY = 2;

let inflightLoad: Promise<LoadResult> | null = null;
// Bumped on runtime switch: an in-flight load from the previous instance must
// not apply its (stale) snapshot after the reset.
let loadGeneration = 0;
/** Coalesce overlapping per-directory refreshes for the same directory set. */
const inflightDirectoryRefresh = new Map<string, Promise<LoadResult>>();

const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const replaced = trimmed.replace(/\\/g, '/');
  if (replaced === '/') {
    return '/';
  }
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

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

const directoryRefreshKey = (directories: Set<string>): string => [...directories].sort().join('\0');

const applyDirectoryRefreshPatch = (
  state: GlobalSessionsState,
  input: {
    activeSessions: Session[];
    archivedSessions: Session[];
    directories: Set<string>;
    fallbackActive?: Session[];
    markReady: boolean;
  },
): Partial<GlobalSessionsState> | GlobalSessionsState => {
  let nextActiveSessions = replaceSessionsForDirectories(
    state.activeSessions,
    input.activeSessions,
    input.directories,
  );
  nextActiveSessions = mergeSessionLists(nextActiveSessions, input.fallbackActive);
  if (sameSessionList(state.activeSessions, nextActiveSessions)) {
    nextActiveSessions = state.activeSessions;
  }

  let nextArchivedSessions = replaceSessionsForDirectories(
    state.archivedSessions,
    input.archivedSessions,
    input.directories,
  );
  if (sameSessionList(state.archivedSessions, nextArchivedSessions)) {
    nextArchivedSessions = state.archivedSessions;
  }

  const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
    ? state.sessionsByDirectory
    : buildSessionsByDirectory(nextActiveSessions);

  let nextLoadedDirectories = state.loadedDirectories;
  let loadedChanged = false;
  for (const directory of input.directories) {
    if (!nextLoadedDirectories.has(directory)) {
      if (!loadedChanged) {
        nextLoadedDirectories = new Set(state.loadedDirectories);
        loadedChanged = true;
      }
      nextLoadedDirectories.add(directory);
    }
  }

  let nextLoadingDirectories = state.loadingDirectories;
  let loadingChanged = false;
  for (const directory of input.directories) {
    if (nextLoadingDirectories.has(directory)) {
      if (!loadingChanged) {
        nextLoadingDirectories = new Set(state.loadingDirectories);
        loadingChanged = true;
      }
      nextLoadingDirectories.delete(directory);
    }
  }

  const nextStatus = input.markReady ? 'ready' as const : state.status;
  const nextHasLoaded = input.markReady ? true : state.hasLoaded;

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
    && nextSessionsByDirectory === state.sessionsByDirectory
    && nextLoadedDirectories === state.loadedDirectories
    && nextLoadingDirectories === state.loadingDirectories
    && state.status === nextStatus
    && state.hasLoaded === nextHasLoaded
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
    loadedDirectories: nextLoadedDirectories,
    loadingDirectories: nextLoadingDirectories,
    hasLoaded: nextHasLoaded,
    status: nextStatus,
  };
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
  loadedDirectories: new Set(),
  loadingDirectories: new Set(),
  hasLoaded: false,
  status: 'idle',

  applySnapshot: (activeSessions, archivedSessions, status = 'ready') => {
    set((state) => applySnapshot(state, activeSessions, archivedSessions, status));
  },

  resetForRuntimeSwitch: () => {
    loadGeneration += 1;
    inflightLoad = null;
    inflightDirectoryRefresh.clear();
    set({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      reviewTransferBySessionId: new Map(),
      loadedDirectories: new Set(),
      loadingDirectories: new Set(),
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
    inflightLoad = (async () => {
      const current = get();

      try {
        const sdk = opencodeClient.getSdkClient();
        const [activeResult, archivedResult] = await Promise.allSettled([
          listGlobalSessionPages(sdk, { archived: false, pageSize: PAGE_SIZE }),
          listGlobalSessionPages(sdk, { archived: true, pageSize: PAGE_SIZE }),
        ]);

        const fallbackSnapshot = mergeSessionLists(current.activeSessions, fallbackActive);
        const nextActiveSessions = activeResult.status === 'fulfilled'
          ? activeResult.value
          : fallbackSnapshot;
        const nextArchivedSessions = archivedResult.status === 'fulfilled'
          ? archivedResult.value
          : current.archivedSessions;

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
        set((state) => applySnapshot(state, nextActiveSessions, nextArchivedSessions, 'ready'));
        return { activeSessions: nextActiveSessions, archivedSessions: nextArchivedSessions };
      } catch (error) {
        if (generation !== loadGeneration) {
          return { activeSessions: [], archivedSessions: [] };
        }
        const nextActiveSessions = mergeSessionLists(current.activeSessions, fallbackActive);
        const nextArchivedSessions = current.archivedSessions;
        console.warn('[GlobalSessions] Failed to load sessions, using fallback snapshot:', error);
        set((state) => applySnapshot(state, nextActiveSessions, nextArchivedSessions, 'error'));
        return { activeSessions: nextActiveSessions, archivedSessions: nextArchivedSessions };
      } finally {
        inflightLoad = null;
      }
    })();

    return inflightLoad;
  },

  refreshSessionsForDirectories: async (directories, fallbackActive) => {
    const directorySet = normalizeDirectorySet(directories);
    if (directorySet.size === 0) {
      // Stay idle when the caller has no directories yet (currentDirectory /
      // projects still hydrating). The sidebar priority effect re-fires when
      // those arrive; flipping to ready here would strand an empty catalog.
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }

    const refreshKey = directoryRefreshKey(directorySet);
    const existing = inflightDirectoryRefresh.get(refreshKey);
    if (existing) {
      return existing;
    }

    const generation = loadGeneration;
    // Mark directories loading immediately so the sidebar can swap the project
    // folder icon for a spinner before the first page returns.
    set((state) => {
      const nextLoading = new Set(state.loadingDirectories);
      for (const directory of directorySet) {
        nextLoading.add(directory);
      }
      return {
        loadingDirectories: nextLoading,
        // Only the first cold-start wave flips idle → loading. Later expand-on-
        // demand refreshes must not re-show a global syncing indicator.
        status: state.status === 'idle' ? 'loading' : state.status,
      };
    });

    const run = (async (): Promise<LoadResult> => {
      const sdk = opencodeClient.getSdkClient();
      const list = [...directorySet];
      let cursor = 0;
      const errors: unknown[] = [];

      // Apply one directory at a time (bounded concurrency). Each successful
      // directory commits its own patch so the sidebar never jumps from empty
      // → thousands of rows in a single React commit.
      const workers = Array.from(
        { length: Math.min(DIRECTORY_FETCH_CONCURRENCY, list.length) },
        async () => {
          while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= list.length) return;
            if (generation !== loadGeneration) return;

            const directory = list[index];
            const dirSet = new Set([directory]);
            try {
              const [activeSessions, archivedSessions] = await Promise.all([
                listGlobalSessionPages(sdk, { directory, archived: false, pageSize: PAGE_SIZE }),
                listGlobalSessionPages(sdk, { directory, archived: true, pageSize: PAGE_SIZE }),
              ]);
              if (generation !== loadGeneration) return;

              set((state) => applyDirectoryRefreshPatch(state, {
                activeSessions,
                archivedSessions,
                directories: dirSet,
                // Fallback live sessions only on the first directory so we
                // don't re-merge the same snapshot N times.
                fallbackActive: index === 0 ? fallbackActive : undefined,
                markReady: true,
              }));
            } catch (error) {
              errors.push(error);
              // Clear the spinner even on failure so the project is not stuck
              // loading forever; loadedDirectories stays unset for retry.
              set((state) => {
                if (!state.loadingDirectories.has(directory)) return state;
                const nextLoading = new Set(state.loadingDirectories);
                nextLoading.delete(directory);
                return { loadingDirectories: nextLoading };
              });
            }
          }
        },
      );

      await Promise.all(workers);

      if (generation !== loadGeneration) {
        return { activeSessions: [], archivedSessions: [] };
      }

      if (errors.length > 0) {
        console.warn('[GlobalSessions] Failed to refresh sessions for some directories:', errors[0]);
      }

      // Drop any directories still marked loading (e.g. aborted mid-flight) and
      // settle global status if we never left the cold-start loading wave.
      set((state) => {
        let nextLoading = state.loadingDirectories;
        let loadingChanged = false;
        for (const directory of directorySet) {
          if (nextLoading.has(directory)) {
            if (!loadingChanged) {
              nextLoading = new Set(state.loadingDirectories);
              loadingChanged = true;
            }
            nextLoading.delete(directory);
          }
        }
        const nextStatus = state.status === 'loading'
          ? (errors.length === list.length ? 'error' as const : 'ready' as const)
          : state.status;
        if (!loadingChanged && state.status === nextStatus && state.hasLoaded) {
          return state;
        }
        return {
          loadingDirectories: nextLoading,
          status: nextStatus,
          hasLoaded: true,
        };
      });

      return { activeSessions: get().activeSessions, archivedSessions: get().archivedSessions };
    })();

    inflightDirectoryRefresh.set(refreshKey, run);
    try {
      return await run;
    } finally {
      inflightDirectoryRefresh.delete(refreshKey);
    }
  },

  upsertSession: (session) => {
    set((state) => {
      const existingSession = state.activeSessions.find((candidate) => candidate.id === session.id)
        ?? state.archivedSessions.find((candidate) => candidate.id === session.id)
        ?? null;
      const sessionWithMetadata = mergeSessionDirectoryMetadata(session, existingSession);
      const isArchived = Boolean(sessionWithMetadata.time?.archived);
      const nextActiveSessions = isArchived
        ? state.activeSessions.filter((candidate) => candidate.id !== session.id)
        : upsertSessionIntoList(state.activeSessions, sessionWithMetadata);
      const nextArchivedSessions = isArchived
        ? upsertSessionIntoList(state.archivedSessions, sessionWithMetadata)
        : state.archivedSessions.filter((candidate) => candidate.id !== session.id);

      if (
        nextActiveSessions === state.activeSessions
        && nextArchivedSessions === state.archivedSessions
      ) {
        return state;
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
      };
    });
  },

  removeSessions: (ids) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const nextActiveSessions = state.activeSessions.filter((session) => !idSet.has(session.id));
      const nextArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      if (
        nextActiveSessions.length === state.activeSessions.length
        && nextArchivedSessions.length === state.archivedSessions.length
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
      };
    });
  },

  archiveSessions: (ids, archivedAt = Date.now()) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
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
        return state;
      }

      const remainingArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: [...movedSessions, ...remainingArchivedSessions],
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
        reviewTransferBySessionId: buildReviewTransferMap(nextActiveSessions),
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
