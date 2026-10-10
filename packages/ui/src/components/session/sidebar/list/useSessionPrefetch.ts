import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
import { isVSCodeRuntime } from '@/lib/desktop';

const SESSION_PREFETCH_HOVER_DELAY_MS = 180;
const SESSION_PREFETCH_SETTLE_MS = 150;
const SESSION_PREFETCH_CONCURRENCY = 2;
const SESSION_PREFETCH_PENDING_LIMIT = 8;
// Only the rows right next to the open session: each speculative load costs
// a history request and a cache slot, and a second neighbor is rarely the
// next click.
const NEIGHBOR_PREFETCH_OFFSETS = [-1, 1];

type Args = {
  enabled?: boolean;
  currentSessionId: string | null;
  sortedSessions: Session[];
  recentSessions?: Session[];
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

/**
 * Speculative message loads a session row asks for while the pointer rests on
 * it or it has keyboard focus. Both go through the same delay, concurrency cap
 * and dedupe as the neighbour prefetch.
 */
export type SessionHoverPrefetch = {
  schedule: (session: PrefetchTarget) => void;
  cancel: (session: PrefetchTarget) => void;
};

const SessionHoverPrefetchContext = React.createContext<SessionHoverPrefetch | null>(null);

/** Null outside the sidebar's prefetch owner, where rows do not prefetch on hover. */
export const useSessionHoverPrefetch = (): SessionHoverPrefetch | null => React.useContext(SessionHoverPrefetchContext);

export const useSessionPrefetch = ({ enabled = true, currentSessionId, sortedSessions, recentSessions = [], prefetchSession }: Args): SessionHoverPrefetch => {
  const sessionPrefetchTimersRef = React.useRef<Map<string, number>>(new Map());
  // Timers only a hover asked for; ending the hover may cancel these, never a
  // neighbor prefetch that happens to target the same row.
  const hoverOnlyTimerKeysRef = React.useRef<Set<string>>(new Set());
  const sessionPrefetchQueueRef = React.useRef<PrefetchRequest[]>([]);
  const sessionPrefetchInFlightRef = React.useRef<Set<string>>(new Set());
  const generationRef = React.useRef(0);
  const prefetchDisabled = React.useMemo(() => isVSCodeRuntime(), []);

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

      // Check if the session is already renderable in the sync child store.
      if (getSyncSessionMaterializationStatus(request.sessionId, request.directory).renderable) {
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
    if (!enabled || prefetchDisabled || !sessionId || !directory || sessionId === currentSessionId) {
      return;
    }
    const request = { sessionId, directory, generation: generationRef.current };
    const key = getPrefetchRequestKey(request);

    // Already renderable in sync
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
      // A pending neighbor prefetch stays one even when a hover passes over it.
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

  // A hover that ends before the delay is not interest in the session. A
  // request already queued or in flight is left alone.
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

  // Stable for the rows: the callbacks behind it change with the open
  // session, and a changing context value would re-render every mounted row.
  const scheduleRef = React.useRef(scheduleSessionPrefetch);
  scheduleRef.current = scheduleSessionPrefetch;
  const [hoverPrefetch] = React.useState<SessionHoverPrefetch>(() => ({
    schedule: (session) => scheduleRef.current(session, 'hover'),
    cancel: cancelSessionPrefetch,
  }));

  React.useEffect(() => {
    clearPendingPrefetches();
  }, [clearPendingPrefetches, currentSessionId, enabled, prefetchDisabled]);

  // Wait for the active session to finish loading before prefetching neighbors.
  // On rapid session switches the timer resets, so only the final session triggers prefetch.
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
    if (!enabled || prefetchDisabled || !currentSessionId || recentSessions.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      const currentIndex = recentSessions.findIndex((session) => session.id === currentSessionId);
      if (currentIndex < 0) return;
      for (const offset of NEIGHBOR_PREFETCH_OFFSETS) scheduleSessionPrefetch(recentSessions[currentIndex + offset]);
    }, SESSION_PREFETCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, enabled, prefetchDisabled, recentSessions, scheduleSessionPrefetch]);

  React.useEffect(() => clearPendingPrefetches, [clearPendingPrefetches]);

  return hoverPrefetch;
};

/**
 * Owns the sidebar's speculative message loads: the rows next to the open
 * session, and a row the pointer rests on or focus reaches. Kept in its own
 * component so the open-session subscription re-renders only this owner, not
 * the rows it provides for.
 */
export const SessionPrefetchProvider: React.FC<Omit<Args, 'currentSessionId'> & { children: React.ReactNode }> = ({ children, ...args }) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const hoverPrefetch = useSessionPrefetch({ ...args, currentSessionId });
  return React.createElement(SessionHoverPrefetchContext.Provider, { value: hoverPrefetch }, children);
};
