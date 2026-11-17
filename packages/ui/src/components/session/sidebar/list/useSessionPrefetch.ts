import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getSettingsSurface } from '@/lib/settings/surface';
import { isSpaceDirectoryStopped } from '@/lib/spaces/spaces-store';

const SESSION_PREFETCH_HOVER_DELAY_MS = 180;
const SESSION_PREFETCH_SETTLE_MS = 150;
const SESSION_PREFETCH_CONCURRENCY = 2;
const SESSION_PREFETCH_PENDING_LIMIT = 8;
const NEIGHBOR_PREFETCH_OFFSETS = [-1, 1];

type Args = {
  enabled?: boolean;
  currentSessionId: string | null;
  sortedSessions: Session[];
  workSessions?: readonly Session[];
  prefetchSession: (target: { directory: string; sessionID: string }) => Promise<void>;
};

type PrefetchRequest = {
  sessionId: string;
  directory: string;
  generation: number;
};

const getPrefetchRequestKey = (request: Pick<PrefetchRequest, 'directory' | 'sessionId'>): string => (
  `${request.directory}\n${request.sessionId}`
);

type PrefetchTarget = Pick<Session, 'id' | 'directory'>;

const sessionDirectory = (session: PrefetchTarget | null | undefined): string | null => {
  const directory = session?.directory?.trim();
  return directory || null;
};

export type SessionHoverPrefetch = {
  schedule: (session: PrefetchTarget) => void;
  cancel: (session: PrefetchTarget) => void;
};

const SessionHoverPrefetchContext = React.createContext<SessionHoverPrefetch | null>(null);

export const useSessionHoverPrefetch = (): SessionHoverPrefetch | null => React.useContext(SessionHoverPrefetchContext);

export const useSessionPrefetch = ({ enabled = true, currentSessionId, sortedSessions, workSessions = [], prefetchSession }: Args): SessionHoverPrefetch => {
  const sessionPrefetchTimersRef = React.useRef<Map<string, number>>(new Map());
  const hoverOnlyTimerKeysRef = React.useRef<Set<string>>(new Set());
  const sessionPrefetchQueueRef = React.useRef<PrefetchRequest[]>([]);
  const sessionPrefetchInFlightRef = React.useRef<Set<string>>(new Set());
  const generationRef = React.useRef(0);
  const prefetchDisabled = React.useMemo(() => isVSCodeRuntime() || getSettingsSurface() === 'mobile', []);

  const clearPendingPrefetches = React.useCallback(() => {
    generationRef.current += 1;
    sessionPrefetchQueueRef.current = [];
    sessionPrefetchTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    sessionPrefetchTimersRef.current.clear();
    hoverOnlyTimerKeysRef.current.clear();
  }, []);

  const pumpSessionPrefetchQueue = React.useCallback(() => {
    if (!enabled || prefetchDisabled) {
      return;
    }

    while (sessionPrefetchInFlightRef.current.size < SESSION_PREFETCH_CONCURRENCY && sessionPrefetchQueueRef.current.length > 0) {
      const request = sessionPrefetchQueueRef.current.shift();
      if (!request) {
        break;
      }
      if (request.generation !== generationRef.current) continue;

      const state = useSessionUIStore.getState();
      if (state.currentSessionId === request.sessionId) {
        continue;
      }

      if (getSyncSessionMaterializationStatus(request.sessionId, request.directory).renderable || isSpaceDirectoryStopped(request.directory)) {
        continue;
      }

      const key = getPrefetchRequestKey(request);
      sessionPrefetchInFlightRef.current.add(key);
      void prefetchSession({ directory: request.directory, sessionID: request.sessionId })
        .catch(() => undefined)
        .finally(() => {
          sessionPrefetchInFlightRef.current.delete(key);
          pumpSessionPrefetchQueue();
        });
    }
  }, [enabled, prefetchDisabled, prefetchSession]);

  const scheduleSessionPrefetch = React.useCallback((session: PrefetchTarget | null | undefined, origin: 'hover' | 'neighbor' = 'neighbor') => {
    const sessionId = session?.id;
    const directory = sessionDirectory(session);
    if (!enabled || prefetchDisabled || !sessionId || !directory || sessionId === currentSessionId || isSpaceDirectoryStopped(directory)) {
      return;
    }
    const request = { sessionId, directory, generation: generationRef.current };
    const key = getPrefetchRequestKey(request);

    if (getSyncSessionMaterializationStatus(sessionId, directory).renderable) {
      return;
    }

    if (sessionPrefetchInFlightRef.current.has(key)) {
      return;
    }

    if (sessionPrefetchQueueRef.current.some((candidate) => getPrefetchRequestKey(candidate) === key)) {
      return;
    }

    const existingTimer = sessionPrefetchTimersRef.current.get(key);
    if (existingTimer !== undefined) {
      if (origin === 'hover' && !hoverOnlyTimerKeysRef.current.has(key)) return;
      window.clearTimeout(existingTimer);
    }
    if (origin === 'hover') hoverOnlyTimerKeysRef.current.add(key);
    else hoverOnlyTimerKeysRef.current.delete(key);

    const timer = window.setTimeout(() => {
      sessionPrefetchTimersRef.current.delete(key);
      hoverOnlyTimerKeysRef.current.delete(key);
      if (request.generation !== generationRef.current) return;
      const queue = sessionPrefetchQueueRef.current;
      if (queue.length >= SESSION_PREFETCH_PENDING_LIMIT) {
        queue.shift();
      }
      queue.push(request);
      pumpSessionPrefetchQueue();
    }, SESSION_PREFETCH_HOVER_DELAY_MS);
    sessionPrefetchTimersRef.current.set(key, timer);
  }, [currentSessionId, enabled, prefetchDisabled, pumpSessionPrefetchQueue]);

  const cancelSessionPrefetch = React.useCallback((session: PrefetchTarget) => {
    const directory = sessionDirectory(session);
    if (!directory) return;
    const key = getPrefetchRequestKey({ sessionId: session.id, directory });
    const timer = sessionPrefetchTimersRef.current.get(key);
    if (timer === undefined || !hoverOnlyTimerKeysRef.current.has(key)) return;
    window.clearTimeout(timer);
    sessionPrefetchTimersRef.current.delete(key);
    hoverOnlyTimerKeysRef.current.delete(key);
  }, []);

  const scheduleRef = React.useRef(scheduleSessionPrefetch);
  scheduleRef.current = scheduleSessionPrefetch;
  const [hoverPrefetch] = React.useState<SessionHoverPrefetch>(() => ({
    schedule: (session) => scheduleRef.current(session, 'hover'),
    cancel: cancelSessionPrefetch,
  }));

  React.useEffect(() => {
    clearPendingPrefetches();
  }, [clearPendingPrefetches, currentSessionId, enabled, prefetchDisabled]);

  React.useEffect(() => {
    if (!enabled || prefetchDisabled || !currentSessionId || sortedSessions.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      const currentIndex = sortedSessions.findIndex((session) => session.id === currentSessionId);
      if (currentIndex < 0) return;
      for (const offset of NEIGHBOR_PREFETCH_OFFSETS) scheduleSessionPrefetch(sortedSessions[currentIndex + offset]);
    }, SESSION_PREFETCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, enabled, prefetchDisabled, scheduleSessionPrefetch, sortedSessions]);

  React.useEffect(() => {
    if (!enabled || prefetchDisabled || !currentSessionId || workSessions.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      const currentIndex = workSessions.findIndex((session) => session.id === currentSessionId);
      if (currentIndex < 0) return;
      for (const offset of NEIGHBOR_PREFETCH_OFFSETS) scheduleSessionPrefetch(workSessions[currentIndex + offset]);
    }, SESSION_PREFETCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, enabled, prefetchDisabled, workSessions, scheduleSessionPrefetch]);

  React.useEffect(() => clearPendingPrefetches, [clearPendingPrefetches]);

  return hoverPrefetch;
};

export const SessionPrefetchProvider: React.FC<Omit<Args, 'currentSessionId'> & { children: React.ReactNode }> = ({ children, ...args }) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const hoverPrefetch = useSessionPrefetch({ ...args, currentSessionId });
  return React.createElement(SessionHoverPrefetchContext.Provider, { value: hoverPrefetch }, children);
};
