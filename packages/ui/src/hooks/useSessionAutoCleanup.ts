import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_DELETE_KEEP_RECENT = 5;
const AUTO_DELETE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const getSessionLastActivity = (session: Session): number => {
  return session.time?.updated ?? session.time?.created ?? 0;
};

type BuildAutoDeleteCandidatesOptions = {
  sessions: Session[];
  currentSessionId: string | null;
  cutoffDays: number;
  keepRecent?: number;
  now?: number;
};

export const buildAutoDeleteCandidates = ({
  sessions,
  currentSessionId,
  cutoffDays,
  keepRecent = AUTO_DELETE_KEEP_RECENT,
  now = Date.now(),
}: BuildAutoDeleteCandidatesOptions): string[] => {
  if (!Array.isArray(sessions) || cutoffDays <= 0) {
    return [];
  }

  const cutoffTime = now - cutoffDays * DAY_MS;
  const sorted = [...sessions].sort(
    (a, b) => getSessionLastActivity(b) - getSessionLastActivity(a)
  );
  const protectedIds = new Set(sorted.slice(0, keepRecent).map((session) => session.id));

  return sorted
    .filter((session) => {
      if (!session?.id) return false;
      if (protectedIds.has(session.id)) return false;
      if (session.id === currentSessionId) return false;
      if (session.share) return false;
      const lastActivity = getSessionLastActivity(session);
      if (!lastActivity) return false;
      return lastActivity < cutoffTime;
    })
    .map((session) => session.id);
};

type CleanupResult = {
  deletedIds: string[];
  failedIds: string[];
  skippedReason?: 'disabled' | 'loading' | 'cooldown' | 'no-candidates' | 'running';
};

type CleanupOptions = {
  autoRun?: boolean;
  enabled?: boolean;
};

export const useSessionAutoCleanup = (options?: CleanupOptions) => {
  const autoRun = options?.autoRun !== false;
  const enabled = options?.enabled ?? true;

  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const isLoading = useSessionStore((state) => state.isLoading);
  const deleteSessions = useSessionStore((state) => state.deleteSessions);

  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const setAutoDeleteLastRunAt = useUIStore((state) => state.setAutoDeleteLastRunAt);

  const [isRunning, setIsRunning] = React.useState(false);
  const runningRef = React.useRef(false);

  const candidates = React.useMemo(() => {
    if (autoDeleteAfterDays <= 0) {
      return [];
    }
    return buildAutoDeleteCandidates({
      sessions,
      currentSessionId,
      cutoffDays: autoDeleteAfterDays,
    });
  }, [autoDeleteAfterDays, currentSessionId, sessions]);

  const runCleanup = React.useCallback(
    async ({ force = false }: { force?: boolean } = {}): Promise<CleanupResult> => {
      if (runningRef.current) {
        return { deletedIds: [], failedIds: [], skippedReason: 'running' };
      }

      if (!autoDeleteEnabled || autoDeleteAfterDays <= 0) {
        if (!force) {
          return { deletedIds: [], failedIds: [], skippedReason: 'disabled' };
        }
      }

      if (isLoading) {
        return { deletedIds: [], failedIds: [], skippedReason: 'loading' };
      }

      const now = Date.now();
      if (!force && autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
        return { deletedIds: [], failedIds: [], skippedReason: 'cooldown' };
      }

      if (sessions.length === 0) {
        return { deletedIds: [], failedIds: [], skippedReason: 'no-candidates' };
      }

      const candidateIds = buildAutoDeleteCandidates({
        sessions,
        currentSessionId,
        cutoffDays: autoDeleteAfterDays,
        now,
      });

      if (candidateIds.length === 0) {
        setAutoDeleteLastRunAt(now);
        return { deletedIds: [], failedIds: [], skippedReason: 'no-candidates' };
      }

      runningRef.current = true;
      setIsRunning(true);
      try {
        const result = await deleteSessions(candidateIds, { silent: true });
        return result;
      } finally {
        runningRef.current = false;
        setIsRunning(false);
        setAutoDeleteLastRunAt(Date.now());
      }
    },
    [
      autoDeleteAfterDays,
      autoDeleteEnabled,
      autoDeleteLastRunAt,
      currentSessionId,
      deleteSessions,
      isLoading,
      sessions,
      setAutoDeleteLastRunAt,
    ]
  );

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!autoRun) {
      return;
    }
    if (!autoDeleteEnabled || autoDeleteAfterDays <= 0) {
      return;
    }
    if (isLoading || sessions.length === 0) {
      return;
    }
    const now = Date.now();
    if (autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
      return;
    }
    void runCleanup();
  }, [
    autoDeleteAfterDays,
    autoDeleteEnabled,
    autoDeleteLastRunAt,
    autoRun,
    enabled,
    isLoading,
    sessions.length,
    runCleanup,
  ]);

  return {
    candidates,
    isRunning,
    runCleanup,
    keepRecentCount: AUTO_DELETE_KEEP_RECENT,
  };
};
