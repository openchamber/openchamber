import { create } from 'zustand';
import type { Session } from '@opencode-ai/sdk/v2';

type GlobalSessionEntry = Session & { serverId?: string };

type GlobalSessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

type LoadResult = {
  activeSessions: GlobalSessionEntry[];
  archivedSessions: GlobalSessionEntry[];
};

type GlobalSessionsState = {
  activeSessions: GlobalSessionEntry[];
  archivedSessions: GlobalSessionEntry[];
  sessionsByDirectory: Map<string, Map<string, GlobalSessionEntry[]>>;
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  applySnapshot: (activeSessions: GlobalSessionEntry[], archivedSessions: GlobalSessionEntry[], status?: GlobalSessionsStatus) => void;
  upsertSession: (session: GlobalSessionEntry | Session) => void;
  removeSessions: (ids: Iterable<string>) => void;
  archiveSessions: (ids: Iterable<string>, archivedAt?: number) => void;
  removeServerEntries: (serverId: string) => void;
};

let inflightLoad: Promise<LoadResult> | null = null;

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

const buildSessionsByDirectory = (sessions: GlobalSessionEntry[]): Map<string, Map<string, GlobalSessionEntry[]>> => {
  const next = new Map<string, Map<string, GlobalSessionEntry[]>>();
  for (const session of sessions) {
    const serverId = session.serverId ?? "local";
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

const upsertSessionIntoList = (sessions: GlobalSessionEntry[], session: GlobalSessionEntry): GlobalSessionEntry[] => {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [session, ...sessions];
  }
  if (getSessionSignature(sessions[index]) === getSessionSignature(session)) {
    return sessions;
  }
  const next = [...sessions];
  next[index] = session;
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
    byId.set(session.id, session);
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

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
    && nextSessionsByDirectory === state.sessionsByDirectory
    && state.hasLoaded
    && state.status === status
  ) {
    return state;
  }

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    sessionsByDirectory: nextSessionsByDirectory,
    hasLoaded: true,
    status,
  };
};

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => ({
  activeSessions: [],
  archivedSessions: [],
  sessionsByDirectory: new Map(),
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

      try {
        const [activeResult, archivedResult] = await Promise.allSettled([
          fetch('/api/servers/all/sessions'),
          fetch('/api/servers/all/sessions?archived=true'),
        ]);

        let nextActiveSessions: GlobalSessionEntry[] = [];
        let nextArchivedSessions: GlobalSessionEntry[] = [];

        if (activeResult.status === 'fulfilled' && activeResult.value.ok) {
          const activeJson = await activeResult.value.json() as { sessions?: GlobalSessionEntry[] };
          nextActiveSessions = activeJson.sessions ?? [];
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

  upsertSession: (session) => {
    set((state) => {
      const isArchived = Boolean(session.time?.archived);
      const nextActiveSessions = isArchived
        ? state.activeSessions.filter((candidate) => candidate.id !== session.id)
        : upsertSessionIntoList(state.activeSessions, session);
      const nextArchivedSessions = isArchived
        ? upsertSessionIntoList(state.archivedSessions, session)
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
