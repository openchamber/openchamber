import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages } from '@/sync/sync-refs';

const SESSION_PREFETCH_HOVER_DELAY_MS = 180;
const SESSION_PREFETCH_SETTLE_MS = 600;
const SESSION_PREFETCH_CONCURRENCY = 1;
const SESSION_PREFETCH_PENDING_LIMIT = 6;

type Args = {
  currentSessionId: string | null;
  sortedSessions: Session[];
  recentSessionIds?: string[];
  loadMessages: (sessionId: string) => Promise<unknown>;
};

export const useSessionPrefetch = ({ currentSessionId, sortedSessions, recentSessionIds = [], loadMessages }: Args): void => {
  const sessionPrefetchTimersRef = React.useRef<Map<string, number>>(new Map());
  const sessionPrefetchQueueRef = React.useRef<string[]>([]);
  const sessionPrefetchInFlightRef = React.useRef<Set<string>>(new Set());

  const pumpSessionPrefetchQueue = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    while (sessionPrefetchInFlightRef.current.size < SESSION_PREFETCH_CONCURRENCY && sessionPrefetchQueueRef.current.length > 0) {
      const nextSessionId = sessionPrefetchQueueRef.current.shift();
      if (!nextSessionId) {
        break;
      }

      const state = useSessionUIStore.getState();
      if (state.currentSessionId === nextSessionId) {
        continue;
      }

      // Check if messages already loaded in sync child store
      const hasMessages = getSyncMessages(nextSessionId).length > 0;
      if (hasMessages) {
        continue;
      }

      sessionPrefetchInFlightRef.current.add(nextSessionId);
      void loadMessages(nextSessionId)
        .catch(() => undefined)
        .finally(() => {
          sessionPrefetchInFlightRef.current.delete(nextSessionId);
          pumpSessionPrefetchQueue();
        });
    }
  }, [loadMessages]);

  const scheduleSessionPrefetch = React.useCallback((sessionId: string | null | undefined) => {
    if (!sessionId || sessionId === currentSessionId || typeof window === 'undefined') {
      return;
    }

    // Already loaded in sync
    const hasMessages = getSyncMessages(sessionId).length > 0;
    if (hasMessages) {
      return;
    }

    if (sessionPrefetchInFlightRef.current.has(sessionId)) {
      return;
    }

    if (sessionPrefetchQueueRef.current.includes(sessionId)) {
      return;
    }

    if (sessionPrefetchQueueRef.current.length >= SESSION_PREFETCH_PENDING_LIMIT) {
      sessionPrefetchQueueRef.current.shift();
    }

    const existingTimer = sessionPrefetchTimersRef.current.get(sessionId);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      sessionPrefetchTimersRef.current.delete(sessionId);
      sessionPrefetchQueueRef.current.push(sessionId);
      pumpSessionPrefetchQueue();
    }, SESSION_PREFETCH_HOVER_DELAY_MS);
    sessionPrefetchTimersRef.current.set(sessionId, timer);
  }, [currentSessionId, pumpSessionPrefetchQueue]);

  // Wait for the active session to finish loading before prefetching neighbors.
  // On rapid session switches the timer resets, so only the final session triggers prefetch.
  React.useEffect(() => {
    if (!currentSessionId || sortedSessions.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      const currentIndex = sortedSessions.findIndex((session) => session.id === currentSessionId);
      if (currentIndex < 0) return;
      scheduleSessionPrefetch(sortedSessions[currentIndex - 1]?.id);
      scheduleSessionPrefetch(sortedSessions[currentIndex + 1]?.id);
    }, SESSION_PREFETCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, scheduleSessionPrefetch, sortedSessions]);

  React.useEffect(() => {
    if (!currentSessionId || recentSessionIds.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      const currentIndex = recentSessionIds.indexOf(currentSessionId);
      if (currentIndex < 0) return;
      scheduleSessionPrefetch(recentSessionIds[currentIndex - 1]);
      scheduleSessionPrefetch(recentSessionIds[currentIndex + 1]);
    }, SESSION_PREFETCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, recentSessionIds, scheduleSessionPrefetch]);

  React.useEffect(() => {
    const prefetchTimers = sessionPrefetchTimersRef.current;
    return () => {
      prefetchTimers.forEach((timer) => {
        clearTimeout(timer);
      });
      prefetchTimers.clear();
      sessionPrefetchQueueRef.current = [];
    };
  }, []);
};
