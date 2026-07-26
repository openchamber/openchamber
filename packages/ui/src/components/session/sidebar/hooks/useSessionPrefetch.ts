import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
import { isVSCodeRuntime } from '@/lib/desktop';

const SESSION_PREFETCH_HOVER_DELAY_MS = 180;
const SESSION_PREFETCH_SETTLE_MS = 600;
const SESSION_PREFETCH_CONCURRENCY = 1;
const SESSION_PREFETCH_PENDING_LIMIT = 6;

type Args = {
  enabled?: boolean;
  currentSessionId: string | null;
  sortedSessions: Session[];
  recentSessions?: Session[];
  prefetchSession: (sessionId: string, directory: string) => Promise<unknown>;
};

type PrefetchRequest = {
  sessionId: string;
  directory: string;
  generation: number;
};

const sessionDirectory = (session: Session | null | undefined): string | null => {
  const directory = (session as (Session & { directory?: string | null }) | null | undefined)?.directory;
  return typeof directory === 'string' && directory.trim() ? directory : null;
};

export const useSessionPrefetch = ({ enabled = true, currentSessionId, sortedSessions, recentSessions = [], prefetchSession }: Args): void => {
  const sessionPrefetchTimersRef = React.useRef<Map<string, number>>(new Map());
  const sessionPrefetchQueueRef = React.useRef<PrefetchRequest[]>([]);
  const sessionPrefetchInFlightRef = React.useRef<Set<string>>(new Set());
  const generationRef = React.useRef(0);
  const prefetchDisabled = React.useMemo(() => isVSCodeRuntime(), []);

  const requestKey = React.useCallback((request: Pick<PrefetchRequest, 'directory' | 'sessionId'>) => (
    `${request.directory}\n${request.sessionId}`
  ), []);

  const clearPendingPrefetches = React.useCallback(() => {
    generationRef.current += 1;
    sessionPrefetchQueueRef.current = [];
    sessionPrefetchTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    sessionPrefetchTimersRef.current.clear();
  }, []);

  const pumpSessionPrefetchQueue = React.useCallback(() => {
    if (!enabled || prefetchDisabled || typeof window === 'undefined') {
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

      const key = requestKey(request);
      sessionPrefetchInFlightRef.current.add(key);
      void prefetchSession(request.sessionId, request.directory)
        .catch(() => undefined)
        .finally(() => {
          sessionPrefetchInFlightRef.current.delete(key);
          pumpSessionPrefetchQueue();
        });
    }
  }, [enabled, prefetchDisabled, prefetchSession, requestKey]);

  const scheduleSessionPrefetch = React.useCallback((session: Session | null | undefined) => {
    const sessionId = session?.id;
    const directory = sessionDirectory(session);
    if (!enabled || prefetchDisabled || !sessionId || !directory || sessionId === currentSessionId || typeof window === 'undefined') {
      return;
    }
    const request = { sessionId, directory, generation: generationRef.current };
    const key = requestKey(request);

    // Already renderable in sync
    if (getSyncSessionMaterializationStatus(sessionId, directory).renderable) {
      return;
    }

    if (sessionPrefetchInFlightRef.current.has(key)) {
      return;
    }

    if (sessionPrefetchQueueRef.current.some((candidate) => requestKey(candidate) === key)) {
      return;
    }

    const existingTimer = sessionPrefetchTimersRef.current.get(key);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      sessionPrefetchTimersRef.current.delete(key);
      if (request.generation !== generationRef.current) return;
      const queue = sessionPrefetchQueueRef.current;
      if (queue.length >= SESSION_PREFETCH_PENDING_LIMIT) {
        queue.shift();
      }
      queue.push(request);
      pumpSessionPrefetchQueue();
    }, SESSION_PREFETCH_HOVER_DELAY_MS);
    sessionPrefetchTimersRef.current.set(key, timer);
  }, [currentSessionId, enabled, prefetchDisabled, pumpSessionPrefetchQueue, requestKey]);

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
      scheduleSessionPrefetch(sortedSessions[currentIndex - 1]);
      scheduleSessionPrefetch(sortedSessions[currentIndex + 1]);
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
      scheduleSessionPrefetch(recentSessions[currentIndex - 1]);
      scheduleSessionPrefetch(recentSessions[currentIndex + 1]);
    }, SESSION_PREFETCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, enabled, prefetchDisabled, recentSessions, scheduleSessionPrefetch]);

  React.useEffect(() => clearPendingPrefetches, [clearPendingPrefetches]);
};

export const SessionPrefetchEffect: React.FC<Omit<Args, 'currentSessionId'>> = (args) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  useSessionPrefetch({ ...args, currentSessionId });
  return null;
};
