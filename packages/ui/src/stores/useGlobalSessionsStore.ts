import { create } from 'zustand';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { listGlobalSessionPages } from '@/stores/globalSessions';
import { getReviewTransferDirection, type ReviewTransferDirection } from '@/lib/reviewFlow';
import { getOriginalSessionID, getReviewSessionID } from '@/lib/sessionReviewMetadata';

type GlobalSessionEntry = Session & { serverId: string };

type GlobalSessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

type LoadResult = {
  activeSessions: GlobalSessionEntry[];
  archivedSessions: GlobalSessionEntry[];
};

type GlobalSessionsState = {
  activeSessions: GlobalSessionEntry[];
  archivedSessions: GlobalSessionEntry[];
  sessionsByDirectory: Map<string, Map<string, GlobalSessionEntry[]>>;
  reviewTransferBySessionId: Map<string, ReviewTransferDirection>;
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  refreshSessionsForDirectories: (directories: Iterable<string>, fallbackActive?: Session[]) => Promise<LoadResult>;
  applySnapshot: (activeSessions: GlobalSessionEntry[], archivedSessions: GlobalSessionEntry[], status?: GlobalSessionsStatus) => void;
  upsertSession: (session: GlobalSessionEntry | Session) => void;
  removeSessions: (ids: Iterable<string>) => void;
  archiveSessions: (ids: Iterable<string>, archivedAt?: number) => void;
  removeServerEntries: (serverId: string) => void;
};

let inflightLoad: Promise<LoadResult> | null = null;

const PAGE_SIZE = 500;

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

export const resolveGlobalSessionServerId = (session: Session): string => {
  const record = session as Session & { serverId?: string | null };
  const raw = record.serverId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'local';
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

const mapsAreEqual = (prev: Map<string, Map<string, GlobalSessionEntry[]>>, next: Map<string, Map<string, GlobalSessionEntry[]>>): boolean => {
  if (prev === next) return true;
  const prevKeys = [...prev.keys()];
  const nextKeys = [...next.keys()];
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of prevKeys) {
    if (!next.has(key)) return false;
    const prevInner = prev.get(key);
    const nextInner = next.get(key);
    if (!prevInner || !nextInner) return !prevInner === !nextInner;
    if (prevInner.size !== nextInner.size) return false;
    for (const innerKey of prevInner.keys()) {
      if (!nextInner.has(innerKey)) return false;
      const prevList = prevInner.get(innerKey);
      const nextList = nextInner.get(innerKey);
      if (!prevList || !nextList) return !prevList === !nextList;
      if (prevList.length !== nextList.length) return false;
      const sortedPrev = [...prevList].sort((a, b) => getSessionSignature(a).localeCompare(getSessionSignature(b)));
      const sortedNext = [...nextList].sort((a, b) => getSessionSignature(a).localeCompare(getSessionSignature(b)));
      for (let i = 0; i < sortedPrev.length; i++) {
        if (getSessionSignature(sortedPrev[i]) !== getSessionSignature(sortedNext[i])) return false;
      }
    }
  }
  return true;
};

let _prevSessionsByDirectory: Map<string, Map<string, GlobalSessionEntry[]>> | null = null;

const buildSessionsByDirectory = (sessions: GlobalSessionEntry[]): Map<string, Map<string, GlobalSessionEntry[]>> => {
  const next = new Map<string, Map<string, GlobalSessionEntry[]>>();
  for (const session of sessions) {
    const serverId = session.serverId || "local";
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) {
      continue;
    }
    let serverMap = next.get(serverId);
    if (!serverMap) {
      serverMap = new Map();
      next.set(serverId, serverMap);
    }
    const existing = serverMap.get(directory);
    if (existing) {
      existing.push(session);
      continue;
    }
    serverMap.set(directory, [session]);
  }
  if (_prevSessionsByDirectory && mapsAreEqual(_prevSessionsByDirectory, next)) {
    return _prevSessionsByDirectory;
  }
  _prevSessionsByDirectory = next;
  return next;
};

const getSessionSignature = (session: GlobalSessionEntry): string => {
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    session.share?.url ?? '',
    JSON.stringify((session as Session & { metadata?: unknown }).metadata ?? null),
    resolveGlobalSessionDirectory(session) ?? '',
    session.serverId ?? '',
  ].join(':');
};

const sameSessionList = (prev: GlobalSessionEntry[], next: GlobalSessionEntry[]): boolean => {
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
  const results = await Promise.allSettled(
    [...directories].map(async (directory) => ({
      directory,
      sessions: await listGlobalSessionPages(sdk, { directory, archived, pageSize: PAGE_SIZE }),
    })),
  );

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

const upsertSessionIntoList = (sessions: GlobalSessionEntry[], session: GlobalSessionEntry): GlobalSessionEntry[] => {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [session, ...sessions];
  }
  const mergedSession = mergeSessionDirectoryMetadata(session, sessions[index]) as GlobalSessionEntry;
  if (getSessionSignature(sessions[index]) === getSessionSignature(mergedSession)) {
    return sessions;
  }
  const next = [...sessions];
  next[index] = mergedSession;
  return next;
};

const mergeSessionLists = (existing: GlobalSessionEntry[], incoming?: GlobalSessionEntry[]): GlobalSessionEntry[] => {
  if (!incoming || incoming.length === 0) {
    return existing;
  }

  if (existing.length === 0) {
    return incoming;
  }

  const byId = new Map(existing.map((session) => [session.id, session]));
  incoming.forEach((session) => {
    byId.set(session.id, mergeSessionDirectoryMetadata(session, byId.get(session.id)) as GlobalSessionEntry);
  });

  const ordered: GlobalSessionEntry[] = [];
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
  activeSessions: GlobalSessionEntry[],
  archivedSessions: GlobalSessionEntry[],
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
  hasLoaded: false,
  status: 'idle',

  applySnapshot: (activeSessions, archivedSessions, status = 'ready') => {
    set((state) => applySnapshot(state, activeSessions, archivedSessions, status));
  },

  loadSessions: async (fallbackActive) => {
    if (inflightLoad) {
      return inflightLoad;
    }

    set((state) => (state.status === 'loading' ? state : { status: 'loading' }));

    inflightLoad = (async () => {
      const current = get();
      const FETCH_TIMEOUT_MS = 30000;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const [activeResult, archivedResult] = await Promise.allSettled([
          runtimeFetch('/api/servers/all/sessions', { signal: controller.signal }),
          runtimeFetch('/api/servers/all/sessions?archived=true', { signal: controller.signal }),
        ]);

        clearTimeout(timeoutId);

        let nextActiveSessions: GlobalSessionEntry[] = [];
        let nextArchivedSessions: GlobalSessionEntry[] = [];

        if (activeResult.status === 'fulfilled' && activeResult.value.ok) {
          const activeJson = await activeResult.value.json() as { sessions?: GlobalSessionEntry[]; errors?: Array<{ serverId: string; error: string }> };
          nextActiveSessions = mergeSessionLists(current.activeSessions, activeJson.sessions);
          if (activeJson.errors && activeJson.errors.length > 0) {
            console.warn('[GlobalSessions] Partial failures loading active sessions:', activeJson.errors);
          }
        } else {
          console.warn('[GlobalSessions] Failed to load active sessions, using fallback:', activeResult.status === 'fulfilled' ? `HTTP ${activeResult.value.status}` : activeResult.reason);
          const fallbackSnapshot = mergeSessionLists(
            current.activeSessions,
            fallbackActive as unknown as GlobalSessionEntry[],
          );
          nextActiveSessions = fallbackSnapshot;
        }

        if (archivedResult.status === 'fulfilled' && archivedResult.value.ok) {
          const archivedJson = await archivedResult.value.json() as { sessions?: GlobalSessionEntry[] };
          nextArchivedSessions = archivedJson.sessions ?? [];
        } else {
          console.warn('[GlobalSessions] Failed to load archived sessions, preserving current snapshot:', archivedResult.status === 'fulfilled' ? `HTTP ${archivedResult.value.status}` : archivedResult.reason);
          nextArchivedSessions = current.archivedSessions;
        }

        set((state) => applySnapshot(state, nextActiveSessions, nextArchivedSessions, 'ready'));
        return { activeSessions: nextActiveSessions, archivedSessions: nextArchivedSessions };
      } catch (error) {
        const fallbackSnapshot = mergeSessionLists(
          current.activeSessions,
          fallbackActive as unknown as GlobalSessionEntry[],
        );
        console.warn('[GlobalSessions] Failed to load sessions, using fallback snapshot:', error);
        set((state) => applySnapshot(state, fallbackSnapshot, current.archivedSessions, 'error'));
        return { activeSessions: fallbackSnapshot, archivedSessions: current.archivedSessions };
      } finally {
        inflightLoad = null;
      }
    })();

    return inflightLoad;
  },

  refreshSessionsForDirectories: async (directories, fallbackActive) => {
    const directorySet = normalizeDirectorySet(directories);
    if (directorySet.size === 0) {
      const state = get();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    }

    const sdk = opencodeClient.getSdkClient();
    const [active, archived] = await Promise.all([
      fetchDirectoryPages(sdk, directorySet, false),
      fetchDirectoryPages(sdk, directorySet, true),
    ]);

    if (active.errors.length > 0) {
      console.warn('[GlobalSessions] Failed to refresh active sessions for some directories:', active.errors[0]);
    }
    if (archived.errors.length > 0) {
      console.warn('[GlobalSessions] Failed to refresh archived sessions for some directories:', archived.errors[0]);
    }

    set((state) => {
      let nextActiveSessions = replaceSessionsForDirectories(state.activeSessions, active.sessions, active.directories) as GlobalSessionEntry[];
      nextActiveSessions = mergeSessionLists(nextActiveSessions, fallbackActive as GlobalSessionEntry[] | undefined);
      if (sameSessionList(state.activeSessions, nextActiveSessions)) {
        nextActiveSessions = state.activeSessions;
      }

      let nextArchivedSessions = replaceSessionsForDirectories(state.archivedSessions, archived.sessions, archived.directories) as GlobalSessionEntry[];
      if (sameSessionList(state.archivedSessions, nextArchivedSessions)) {
        nextArchivedSessions = state.archivedSessions;
      }

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
    const rawServerId = (session as GlobalSessionEntry).serverId
    const normalized: GlobalSessionEntry = typeof rawServerId === 'string' && rawServerId.length > 0
      ? session as GlobalSessionEntry
      : { ...session, serverId: 'local' as const };
    set((state) => {
      const existingSession = state.activeSessions.find((candidate) => candidate.id === session.id)
        ?? state.archivedSessions.find((candidate) => candidate.id === session.id)
        ?? null;
      const sessionWithMetadata = mergeSessionDirectoryMetadata(normalized, existingSession) as GlobalSessionEntry;
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
      const movedSessions: GlobalSessionEntry[] = [];
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

  removeServerEntries: (serverId) => {
    set((state) => {
      const prevCount = state.activeSessions.length + state.archivedSessions.length;
      const nextActiveSessions = state.activeSessions.filter((s) => s.serverId !== serverId);
      const nextArchivedSessions = state.archivedSessions.filter((s) => s.serverId !== serverId);
      if (nextActiveSessions.length + nextArchivedSessions.length === prevCount) return state;
      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
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
