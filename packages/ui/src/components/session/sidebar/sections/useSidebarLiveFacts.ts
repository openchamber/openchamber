import React from 'react';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { isSessionUnread } from '@/sync/session-unread';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { resolveProjectContextId, type ProjectRef } from '@/lib/projectContextApi';
import { EMPTY_SIDEBAR_LIVE_FACTS, type SidebarLiveFacts } from './workFacts';

const EMPTY_IDS: ReadonlySet<string> = new Set();
type BlockingMap = ReturnType<typeof useGlobalBlockingRequestsStore.getState>['bySession'];
const EMPTY_BLOCKING: BlockingMap = new Map();

/** The ids of top-level sessions whose last turn is unread and of those whose last turn failed, as one comparable key. */
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

/**
 * The live state the user's sections filter on, subscribed only while a shown
 * section asks for it: membership in those sections changes on every turn,
 * and nothing else in the list needs to rebuild for it.
 */
export const useSidebarLiveFacts = (enabled: boolean): SidebarLiveFacts => {
  // Membership of the active set changes only when a turn starts or ends.
  const activeIds = useGlobalSessionStatusStore((state) => (enabled ? state.activeSessionIds : EMPTY_IDS));
  const blocking = useGlobalBlockingRequestsStore((state) => (enabled ? state.bySession : EMPTY_BLOCKING));
  const outcomeKey = useGlobalSessionsStore(React.useCallback((state) => (enabled ? selectTurnOutcomeKey(state) : ''), [enabled]));
  return React.useMemo(() => {
    if (!enabled) return EMPTY_SIDEBAR_LIVE_FACTS;
    const [unread = '', failed = ''] = outcomeKey.split('|');
    return {
      activeIds,
      blockingIds: new Set([...blocking].flatMap(([sessionId, pending]) => (
        pending.permissions.length + pending.forms.length + pending.pages.length > 0 ? [sessionId] : []
      ))),
      unreadIds: new Set(unread ? unread.split(',') : []),
      failedIds: new Set(failed ? failed.split(',') : []),
    };
  }, [activeIds, blocking, enabled, outcomeKey]);
};

/** The start of the local hour: a local midnight is always one, whatever the time zone's offset. */
const localHourStart = (): number => {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  return date.getTime();
};

/**
 * The time the user's sections compare activity against, moved on by the
 * hour while a shown section filters by activity: "Today" turns over at
 * midnight and "Idle 3+ days" ages without any other change to the list.
 * The list rebuilds once an hour, never on every minute.
 */
export const useSidebarSectionsNow = (active: boolean): number => {
  const [hourStart, setHourStart] = React.useState(localHourStart);
  React.useEffect(() => {
    if (!active) return;
    const check = (): void => {
      const next = localHourStart();
      setHourStart((current) => (current === next ? current : next));
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return hourStart;
};

const EMPTY_PLAN_SESSIONS: ReadonlySet<string> = new Set();

/**
 * The sessions a project plan was sent to. Plans live with each project's
 * knowledge, so `projects` are only those a shown section asks plans of:
 * each is read once through the background gate, and again when the server
 * says its knowledge changed. A project whose knowledge failed to load lists none.
 */
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
