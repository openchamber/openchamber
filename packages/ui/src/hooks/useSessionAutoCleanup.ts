import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { ensureGlobalSessionsLoaded, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import {
  buildSessionRetentionCandidates,
  currentRetentionAbsences,
  inWorkKeepsSessions,
  isSessionKeptByUser,
  lastRetentionRunAt,
  RETENTION_INTERVAL_MS,
  RETENTION_KEEP_RECENT,
  runSessionRetentionCleanup,
  useSessionRetentionRunStore,
} from '@/sync/session-retention';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';

const EMPTY_SESSIONS: Session[] = [];
const ACTIVE_USE_WINDOW_MS = 10 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'focus', 'visibilitychange'] as const;
type CleanupOptions = { autoRun?: boolean; enabled?: boolean };

const isRunDue = (storedLastRunAt: number | null) => {
  const lastRunAt = lastRetentionRunAt(storedLastRunAt);
  return lastRunAt === null || !Number.isFinite(lastRunAt) || Date.now() - lastRunAt >= RETENTION_INTERVAL_MS;
};

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
  const pinnedIds = useSessionPinnedStore((state) => state.ids);
  const workKeeps = useUIStore(inWorkKeepsSessions);
  const lastActivityAtRef = React.useRef(document.visibilityState === 'hidden' ? 0 : Date.now());
  const [activityTick, setActivityTick] = React.useState(0);
  const watchActivity = enabled && autoRun;

  React.useEffect(() => {
    if (!watchActivity) return;
    const onActivity = () => {
      if (document.visibilityState === 'hidden') return;
      lastActivityAtRef.current = Date.now();
      const settings = useUIStore.getState();
      if (settings.autoDeleteEnabled && isRunDue(settings.autoDeleteLastRunAt)) setActivityTick((tick) => tick + 1);
    };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, true);
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, true);
    };
  }, [watchActivity]);

  React.useEffect(() => {
    if (!needsGlobalSessions) return;
    if (autoRun && !isRunDue(autoDeleteLastRunAt)) return;
    void ensureGlobalSessionsLoaded();
  }, [needsGlobalSessions, autoRun, autoDeleteLastRunAt, activityTick]);

  const candidates = React.useMemo(() => {
    const now = Date.now();
    return buildSessionRetentionCandidates({
      sessions: [...activeSessions, ...archivedSessions],
      currentSessionId,
      cutoffDays: autoDeleteAfterDays,
      action,
      onlyArchived,
      activeSessionIds,
      isKept: (session) => isSessionKeptByUser(session, pinnedIds, workKeeps),
      absences: autoDeleteEnabled ? currentRetentionAbsences({
        storedLastRunAt: autoDeleteLastRunAt, cutoffDays: autoDeleteAfterDays, now,
      }) : [],
      now,
    });
  }, [activeSessions, archivedSessions, currentSessionId, autoDeleteAfterDays, action, onlyArchived, activeSessionIds, pinnedIds, workKeeps,
    autoDeleteEnabled, autoDeleteLastRunAt]);

  React.useEffect(() => {
    if (!enabled || !autoRun || !autoDeleteEnabled || autoDeleteAfterDays <= 0
      || isLoading || status !== 'ready' || isRunning) return;
    if (!isRunDue(autoDeleteLastRunAt) || Date.now() - lastActivityAtRef.current > ACTIVE_USE_WINDOW_MS) return;
    void runSessionRetentionCleanup().catch((error) => {
      console.error('[SessionRetention] Cleanup failed', error);
    });
  }, [enabled, autoRun, autoDeleteEnabled, autoDeleteAfterDays, isLoading, status, isRunning, autoDeleteLastRunAt, activityTick]);

  return {
    candidates,
    isRunning,
    status,
    runCleanup: runSessionRetentionCleanup,
    keepRecentCount: RETENTION_KEEP_RECENT,
    action,
  };
};
