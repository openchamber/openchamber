import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { ensureGlobalSessionsLoaded, useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useUIStore } from '@/stores/useUIStore';
import { getCompatibleSessionShareUrl } from '@/sync/compat';

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
      if (getCompatibleSessionShareUrl(session)) return false;
      const lastActivity = getSessionLastActivity(session);
      if (!lastActivity) return false;
      return lastActivity < cutoffTime;
    })
    .map((session) => session.id);
};

type CleanupResult = {
  completedIds: string[];
  failedIds: string[];
  action: 'archive' | 'delete';
  skippedReason?: 'disabled' | 'loading' | 'cooldown' | 'no-candidates' | 'running';
};

type CleanupOptions = {
  autoRun?: boolean;
  enabled?: boolean;
};

export const useSessionAutoCleanup = (enabledOrOptions?: boolean | CleanupOptions) => {
  const options = typeof enabledOrOptions === 'object' ? enabledOrOptions : undefined;
  const autoRun = options?.autoRun !== false;
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (options?.enabled ?? true);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isLoading = useSessionUIStore((state) => state.isLoading);
  const globalSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const hasLoadedGlobalSessions = useGlobalSessionsStore((state) => state.hasLoaded);

  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const setAutoDeleteLastRunAt = useUIStore((state) => state.setAutoDeleteLastRunAt);

  const [isRunning, setIsRunning] = React.useState(false);
  const runningRef = React.useRef(false);

  React.useEffect(() => {
    void ensureGlobalSessionsLoaded(getAllSyncSessions());
  }, []);

  const candidates = React.useMemo(() => {
    if (autoDeleteAfterDays <= 0) {
      return [];
    }
    return buildAutoDeleteCandidates({
      sessions: globalSessions,
      currentSessionId,
      cutoffDays: autoDeleteAfterDays,
    });
  }, [autoDeleteAfterDays, currentSessionId, globalSessions]);

  const runCleanup = React.useCallback(
      async ({ force = false }: { force?: boolean } = {}): Promise<CleanupResult> => {
      if (runningRef.current) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'running' };
      }

      if (!autoDeleteEnabled || autoDeleteAfterDays <= 0) {
        if (!force) {
          return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'disabled' };
        }
      }

      if (isLoading) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'loading' };
      }

      const now = Date.now();
      if (!force && autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'cooldown' };
      }

      const { activeSessions: sessions } = await ensureGlobalSessionsLoaded(getAllSyncSessions());

      if (sessions.length === 0) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'no-candidates' };
      }

      const candidateIds = buildAutoDeleteCandidates({
        sessions,
        currentSessionId,
        cutoffDays: autoDeleteAfterDays,
        now,
      });

      if (candidateIds.length === 0) {
        setAutoDeleteLastRunAt(now);
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'no-candidates' };
      }

      runningRef.current = true;
      setIsRunning(true);
      try {
        const sessionMap = new Map(sessions.map((session) => [session.id, session]));
        const completedIds: string[] = [];
        const failedIds: string[] = [];

        for (const id of candidateIds) {
          const session = sessionMap.get(id);
          const directory = session ? resolveGlobalSessionDirectory(session) : null;
          if (!directory) {
            failedIds.push(id);
            continue;
          }

          const scopedSdk = opencodeClient.getScopedSdkClient(directory);

          try {
            if (sessionRetentionAction === 'archive') {
              await scopedSdk.session.update({ sessionID: id, directory, time: { archived: Date.now() } });
            } else {
              await scopedSdk.session.delete({ sessionID: id, directory });
            }
            completedIds.push(id);
          } catch {
            failedIds.push(id);
          }
        }

        if (sessionRetentionAction === 'archive') {
          useGlobalSessionsStore.getState().archiveSessions(completedIds);
        } else {
          useGlobalSessionsStore.getState().removeSessions(completedIds);
        }
        return { completedIds, failedIds, action: sessionRetentionAction };
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
      isLoading,
      sessionRetentionAction,
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
    if (isLoading || !hasLoadedGlobalSessions || globalSessions.length === 0) {
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
    hasLoadedGlobalSessions,
    globalSessions.length,
    isLoading,
    runCleanup,
  ]);

  return {
    candidates,
    isRunning,
    runCleanup,
    keepRecentCount: AUTO_DELETE_KEEP_RECENT,
    action: sessionRetentionAction,
  };
};
