import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { ensureGlobalSessionsLoaded, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import {
  buildSessionRetentionCandidates,
  RETENTION_INTERVAL_MS,
  RETENTION_KEEP_RECENT,
  runSessionRetentionCleanup,
  useSessionRetentionRunStore,
} from '@/sync/session-retention';
import { useUIStore } from '@/stores/useUIStore';

const EMPTY_SESSIONS: Session[] = [];
type CleanupOptions = { autoRun?: boolean; enabled?: boolean };

export const useSessionAutoCleanup = ({ autoRun = true, enabled = true }: CleanupOptions = {}) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isLoading = useSessionUIStore((state) => state.isLoading);
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const onlyArchived = useUIStore((state) => state.sessionRetentionOnlyArchived);
  const action = useUIStore((state) => state.sessionRetentionOnlyArchived ? 'delete' : state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const needsGlobalSessions = enabled && (!autoRun || autoDeleteEnabled);
  const activeSessions = useGlobalSessionsStore((state) => needsGlobalSessions ? state.activeSessions : EMPTY_SESSIONS);
  const archivedSessions = useGlobalSessionsStore((state) => needsGlobalSessions ? state.archivedSessions : EMPTY_SESSIONS);
  const status = useGlobalSessionsStore((state) => state.status);
  const activeSessionIds = useGlobalSessionStatusStore((state) => state.activeSessionIds);
  const isRunning = useSessionRetentionRunStore((state) => state.isRunning);

  React.useEffect(() => {
    if (needsGlobalSessions) void ensureGlobalSessionsLoaded();
  }, [needsGlobalSessions]);

  const candidates = React.useMemo(() => buildSessionRetentionCandidates({
    sessions: [...activeSessions, ...archivedSessions],
    currentSessionId,
    cutoffDays: autoDeleteAfterDays,
    action,
    onlyArchived,
    activeSessionIds,
  }), [activeSessions, archivedSessions, currentSessionId, autoDeleteAfterDays, action, onlyArchived, activeSessionIds]);

  React.useEffect(() => {
    if (!enabled || !autoRun || !autoDeleteEnabled || autoDeleteAfterDays <= 0
      || isLoading || status !== 'ready' || isRunning) return;
    if (autoDeleteLastRunAt && Date.now() - autoDeleteLastRunAt < RETENTION_INTERVAL_MS) return;
    void runSessionRetentionCleanup().catch((error) => {
      console.error('[SessionRetention] Cleanup failed', error);
    });
  }, [enabled, autoRun, autoDeleteEnabled, autoDeleteAfterDays, isLoading, status, isRunning, autoDeleteLastRunAt]);

  return {
    candidates,
    isRunning,
    status,
    runCleanup: runSessionRetentionCleanup,
    keepRecentCount: RETENTION_KEEP_RECENT,
    action,
  };
};
