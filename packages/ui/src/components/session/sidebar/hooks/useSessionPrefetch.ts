import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionStore } from '@/stores/useSessionStore';

const SESSION_PREFETCH_HOVER_DELAY_MS = 180;
const SESSION_PREFETCH_CONCURRENCY = 1;
const SESSION_PREFETCH_PENDING_LIMIT = 6;

type Args = {
  currentSessionId: string | null;
  sortedSessions: Session[];
  loadMessages: (sessionId: string, limit?: number) => Promise<void>;
};

export const useSessionPrefetch = ({ currentSessionId, sortedSessions, loadMessages }: Args): void => {
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

      const state = useSessionStore.getState();
      if (state.currentSessionId === nextSessionId) {
        continue;
      }

      const hasMessages = state.messages.has(nextSessionId);
      const historyMeta = state.sessionHistoryMeta.get(nextSessionId);
      const isHydrated = hasMessages && typeof historyMeta?.complete === 'boolean';
      if (isHydrated) {
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

    const state = useSessionStore.getState();
    const hasMessages = state.messages.has(sessionId);
    const historyMeta = state.sessionHistoryMeta.get(sessionId);
    const isHydrated = hasMessages && typeof historyMeta?.complete === 'boolean';
    if (isHydrated) {
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

  React.useEffect(() => {
    if (!currentSessionId || sortedSessions.length === 0) {
      return;
    }
    const currentIndex = sortedSessions.findIndex((session) => session.id === currentSessionId);
    if (currentIndex < 0) {
      return;
    }
    scheduleSessionPrefetch(sortedSessions[currentIndex - 1]?.id);
    scheduleSessionPrefetch(sortedSessions[currentIndex + 1]?.id);
  }, [currentSessionId, scheduleSessionPrefetch, sortedSessions]);

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
