import React from 'react';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useBackgroundImagesStore } from '@/sync/background-images';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { collectOpenTurnSessionIds, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { usePrWatchStore } from '@/sync/pr-watch';
import { useExtensionWaitsStore } from '@/sync/extension-waits';
import { isSessionUnread } from '@/sync/session-unread';
import { useWorkflowActivityStore } from '@/sync/workflow-activity';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { resolveProjectContextId, type ProjectRef } from '@/lib/projectContextApi';
import { EMPTY_SIDEBAR_LIVE_FACTS, type SidebarLiveFacts } from './workFacts';
import { localDayStart } from '../timelineDates';

const EMPTY_IDS: ReadonlySet<string> = new Set();
type BlockingMap = ReturnType<typeof useGlobalBlockingRequestsStore.getState>['bySession'];
const EMPTY_BLOCKING: BlockingMap = new Map();
type PrWatchMap = ReturnType<typeof usePrWatchStore.getState>['bySession'];
const EMPTY_PR_WATCHES: PrWatchMap = new Map();
type ExtensionWaitMap = ReturnType<typeof useExtensionWaitsStore.getState>['bySession'];
const EMPTY_EXTENSION_WAITS: ExtensionWaitMap = new Map();

const selectTurnOutcomeKey = (state: ReturnType<typeof useGlobalSessionsStore.getState>): string => {
  const unread: string[] = [];
  const failed: string[] = [];
  for (const session of state.entityById.values()) {
    if (session.parentID || session.time.archived !== undefined) continue;
    if (isSessionUnread(session)) unread.push(session.id);
    if (session.outcome === 'failed') failed.push(session.id);
  }
  return `${unread.sort().join(',')}|${failed.sort().join(',')}`;
};

export const useSidebarLiveFacts = (enabled: boolean): SidebarLiveFacts => {
  const activeIds = useGlobalSessionStatusStore((state) => (enabled ? state.activeSessionIds : EMPTY_IDS));
  const workflowIds = useWorkflowActivityStore((state) => (enabled ? state.runningSessionIds : EMPTY_IDS));
  const shellIds = useBackgroundShellsStore((state) => (enabled ? state.sessionIds : EMPTY_IDS));
  const imageIds = useBackgroundImagesStore((state) => (enabled ? state.sessionIds : EMPTY_IDS));
  const prWatches = usePrWatchStore((state) => (enabled ? state.bySession : EMPTY_PR_WATCHES));
  const extensionWaits = useExtensionWaitsStore((state) => (enabled ? state.bySession : EMPTY_EXTENSION_WAITS));
  const blocking = useGlobalBlockingRequestsStore((state) => (enabled ? state.bySession : EMPTY_BLOCKING));
  const outcomeKey = useGlobalSessionsStore(React.useCallback((state) => (enabled ? selectTurnOutcomeKey(state) : ''), [enabled]));
  return React.useMemo(() => {
    if (!enabled) return EMPTY_SIDEBAR_LIVE_FACTS;
    const [unread = '', failed = ''] = outcomeKey.split('|');
    const openTurnIds = collectOpenTurnSessionIds(activeIds, [workflowIds, shellIds, imageIds, prWatches.keys(), extensionWaits.keys()]);
    return {
      activeIds: openTurnIds,
      blockingIds: new Set([...blocking].flatMap(([sessionId, pending]) => (
        pending.permissions.length + pending.forms.length + pending.pages.length > 0 ? [sessionId] : []
      ))),
      unreadIds: new Set(unread ? unread.split(',').filter((sessionId) => !openTurnIds.has(sessionId)) : []),
      failedIds: new Set(failed ? failed.split(',') : []),
    };
  }, [activeIds, blocking, enabled, extensionWaits, imageIds, outcomeKey, prWatches, shellIds, workflowIds]);
};

type SidebarClock = { hourStart: number; dayStart: number };

export const readSidebarClock = (current: SidebarClock | null, nowMs = Date.now()): SidebarClock => {
  const date = new Date(nowMs);
  date.setMinutes(0, 0, 0);
  const next = { hourStart: date.getTime(), dayStart: localDayStart(nowMs) };
  return current && current.hourStart === next.hourStart && current.dayStart === next.dayStart ? current : next;
};

export const useSidebarClocks = (visible: boolean, timeGrouping: boolean, activityFilters: boolean) => {
  const active = visible && (timeGrouping || activityFilters);
  const [clock, setClock] = React.useState(() => readSidebarClock(null));
  React.useEffect(() => {
    if (!active) return;
    const check = (): void => setClock((current) => readSidebarClock(current));
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return {
    activityFilterNow: activityFilters ? clock.hourStart : 0,
    timelineTodayStart: timeGrouping ? clock.dayStart : 0,
  };
};

const EMPTY_PLAN_SESSIONS: ReadonlySet<string> = new Set();

export const useSidebarPlanSessions = (projects: readonly ProjectRef[]): ReadonlySet<string> => {
  const enabled = projects.length > 0;
  const entries = useProjectContextStore((state) => (enabled ? state.entries : null));
  React.useEffect(() => {
    if (!enabled) return;
    const byContextId = new Map(projects.map((project) => [resolveProjectContextId(project), project]));
    const read = (project: ProjectRef, force: boolean): void => {
      void runBackgroundNetworkTask(() => useProjectContextStore.getState().load(project, { force }));
    };
    const store = useProjectContextStore.getState();
    for (const [contextId, project] of byContextId) {
      const entry = store.entries[contextId];
      if (!entry || (!entry.loaded && !entry.loading && !entry.error)) read(project, false);
    }
    return subscribeOpenchamberEvents((event) => {
      if (event.type !== 'project-context-changed') return;
      const project = byContextId.get(event.projectId);
      if (project) read(project, true);
    });
  }, [enabled, projects]);
  return React.useMemo(() => {
    if (!entries) return EMPTY_PLAN_SESSIONS;
    const ids = new Set<string>();
    for (const project of projects) {
      for (const plan of entries[resolveProjectContextId(project)]?.plans ?? []) if (plan.session) ids.add(plan.session.sessionId);
    }
    return ids;
  }, [entries, projects]);
};
