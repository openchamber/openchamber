import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';
import type { Session, SessionStatus } from '@/lib/opencode/model';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  applySessionOrderingMutations,
  reconcileSessionActivitySnapshot,
  type SessionOrderingMutation,
} from './session-ordering';
import {
  applySessionActivityTimingMutations,
  reconcileSessionActivityTiming,
  type SessionActivityTimingMutation,
} from './session-activity-timing';
import { countSyncPerformance } from './performance-diagnostics';
import { hasRunningShell, useBackgroundShellsStore } from './background-shells';
import { hasRunningImage, useBackgroundImagesStore } from './background-images';
import { useWorkflowActivityStore } from './workflow-activity';
import { usePrWatchStore } from './pr-watch';

// Shared live busy/retry index for every directory. Global events update it
// incrementally and authoritative directory snapshots reconcile it, so each
// sidebar row can subscribe to one leaf instead of every child store.
//
// Only non-idle entries are kept; absence alone does not prove idle. Entries carry their
// directory so a polled per-directory snapshot can authoritatively replace
// that directory's slice (the server omits idle sessions from snapshots).

type ActiveStatusType = 'busy' | 'retry';

type GlobalSessionStatusEntry = { status: SessionStatus; directory: string };

type GlobalSessionStatusState = {
  /** Last explicitly observed activity/outcome. Bounded memory, never persisted. */
  observedById: ReadonlyMap<string, { directory: string; outcome: 'completed' | 'failed' | null }>;
  statusById: Map<string, GlobalSessionStatusEntry>;
  activeSessionIds: ReadonlySet<string>;
};

const EMPTY_ACTIVE_SESSION_IDS: ReadonlySet<string> = new Set();

const initialState: GlobalSessionStatusState = {
  observedById: new Map(),
  statusById: new Map(),
  activeSessionIds: EMPTY_ACTIVE_SESSION_IDS,
};

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => initialState);
useGlobalSessionStatusStore.subscribe(() => countSyncPerformance('globalStatusPublications'));

type SessionStatusTransitionListener = (sessionId: string, activeSessionIds: ReadonlySet<string>) => void;
const transitionListeners = new Set<SessionStatusTransitionListener>();

/** Runs synchronously for each ordered status event, before the batch is published.
 * The active-ID draft is valid only during the callback; listeners must not retain it.
 */
export const subscribeSessionStatusTransitions = (listener: SessionStatusTransitionListener): (() => void) => {
  transitionListeners.add(listener);
  return () => { transitionListeners.delete(listener); };
};

/**
 * Replaces the status map wholesale and derives active membership from it.
 * This is the ONE sanctioned way to swap statusById from outside the event
 * reducers (runtime switch, tests) — previously a setState monkeypatch
 * derived membership for arbitrary callers, which silently trusted any
 * caller passing both fields to keep them consistent.
 */
export const replaceGlobalSessionStatusById = (statusById: Map<string, GlobalSessionStatusEntry>): void => {
  const current = useGlobalSessionStatusStore.getState();
  const nextActiveSessionIds = new Set<string>();
  for (const [sessionId, entry] of statusById) {
    if (entry.status.type === 'busy' || entry.status.type === 'retry') {
      nextActiveSessionIds.add(sessionId);
    }
  }
  const sameMembership = nextActiveSessionIds.size === current.activeSessionIds.size
    && [...nextActiveSessionIds].every((sessionId) => current.activeSessionIds.has(sessionId));
  useGlobalSessionStatusStore.setState({
    observedById: new Map(),
    statusById,
    activeSessionIds: sameMembership ? current.activeSessionIds : nextActiveSessionIds,
  });
};

// A parent session goes idle while a background subagent keeps working in a
// child session; OpenCode then hands the result back and the parent runs
// again. For everything the user reads as "this session is working" (the row's
// status dot and turn timer), that pause is still the same turn. The parent
// lookup is injected by the sync provider: the sessions store sits above this
// module in the import graph.
type SessionParentResolver = (sessionId: string) => string | undefined;
let resolveSessionParentId: SessionParentResolver = () => undefined;

export const setSessionParentResolver = (resolver: SessionParentResolver): void => {
  resolveSessionParentId = resolver;
};

/** Subagents nest; a deeper chain than this is treated as unrelated. */
const MAX_SUBAGENT_DEPTH = 8;

const forEachAncestorId = (sessionId: string, visit: (ancestorId: string) => void, resolveParentId: SessionParentResolver = resolveSessionParentId): void => {
  let current = resolveParentId(sessionId);
  for (let depth = 0; current && depth < MAX_SUBAGENT_DEPTH; depth += 1) {
    visit(current);
    current = resolveParentId(current);
  }
};

/** True when a subagent anywhere below the session is running. */
export const hasActiveSubagent = (sessionId: string, activeSessionIds: ReadonlySet<string>, resolveParentId: SessionParentResolver = resolveSessionParentId): boolean => {
  for (const activeId of activeSessionIds) {
    if (activeId === sessionId) continue;
    let found = false;
    forEachAncestorId(activeId, (ancestorId) => {
      if (ancestorId === sessionId) found = true;
    }, resolveParentId);
    if (found) return true;
  }
  return false;
};

/**
 * Active sessions plus every session whose turn they keep open: ancestors of
 * running subagents, and sessions waiting on a background command, an image
 * or a pull request.
 */
const withBackgroundWork = (activeSessionIds: ReadonlySet<string>): ReadonlySet<string> => {
  let extended: Set<string> | null = null;
  const add = (sessionId: string): void => {
    if (activeSessionIds.has(sessionId)) return;
    extended ??= new Set(activeSessionIds);
    extended.add(sessionId);
  };
  for (const activeId of activeSessionIds) forEachAncestorId(activeId, add);
  for (const sessionId of useBackgroundShellsStore.getState().sessionIds) add(sessionId);
  for (const sessionId of useBackgroundImagesStore.getState().sessionIds) add(sessionId);
  for (const sessionId of usePrWatchStore.getState().bySession.keys()) add(sessionId);
  return extended ?? activeSessionIds;
};

/** True when something the session waits on keeps its turn open and will hand it back. */
export const hasBackgroundWork = (sessionId: string, activeSessionIds: ReadonlySet<string>): boolean => (
  hasActiveSubagent(sessionId, activeSessionIds)
  || hasRunningShell(sessionId)
  || hasRunningImage(sessionId)
  || usePrWatchStore.getState().bySession.has(sessionId)
);

/**
 * What keeps the session's turn open, or null when nothing does: the session
 * runs itself, or it idles while a workflow run it proposed runs, or while a
 * subagent below it runs, or while a command or an image it started in the
 * background runs, or while it waits on its pull request. The session's own run wins; a workflow comes next, because its agents
 * are subagents too and the run says what they are doing; then a subagent.
 * The workflow state is the run's own (the OpenChamber server's runs, kept by
 * its events, see `workflow-activity.ts`), so it holds between phases when no
 * agent happens to be busy.
 */
type SessionTurnActivity = 'running' | 'workflow' | 'subagent' | 'shell' | 'image' | 'pullRequest';

/**
 * The order above: the session's own run, a workflow, a subagent, a command,
 * an image, and last an agent waiting on its pull request (`pr-watch.ts`): the server
 * wakes it, as a background subagent's result does.
 */
export const resolveSessionTurnActivity = (
  status: 'running' | 'subagent' | null,
  workflowRunning: boolean,
  waitingOnShell: boolean,
  waitingOnPullRequest = false,
  waitingOnImage = false,
): SessionTurnActivity | null => {
  if (status === 'running') return status;
  if (workflowRunning) return 'workflow';
  if (status) return status;
  if (waitingOnShell) return 'shell';
  if (waitingOnImage) return 'image';
  return waitingOnPullRequest ? 'pullRequest' : null;
};

export const useSessionTurnActivity = (sessionId: string): SessionTurnActivity | null => {
  const status = useGlobalSessionStatusStore((state): 'running' | 'subagent' | null => {
    if (state.activeSessionIds.has(sessionId)) return 'running';
    return hasActiveSubagent(sessionId, state.activeSessionIds) ? 'subagent' : null;
  });
  const workflowRunning = useWorkflowActivityStore((state) => state.runningSessionIds.has(sessionId));
  const waitingOnShell = useBackgroundShellsStore((state) => state.sessionIds.has(sessionId));
  const waitingOnImage = useBackgroundImagesStore((state) => state.sessionIds.has(sessionId));
  const waitingOnPullRequest = usePrWatchStore((state) => state.bySession.has(sessionId));
  return resolveSessionTurnActivity(status, workflowRunning, waitingOnShell, waitingOnPullRequest, waitingOnImage);
};

/** The first of the sessions `useSessionTurnActivity` reads as working, or null. */
export const useFirstSessionWithOpenTurn = (sessionIds: readonly string[]): string | null => {
  const inTurn = useGlobalSessionStatusStore((state) => (
    sessionIds.find((id) => state.activeSessionIds.has(id) || hasActiveSubagent(id, state.activeSessionIds)) ?? null
  ));
  const inWorkflow = useWorkflowActivityStore((state) => sessionIds.find((id) => state.runningSessionIds.has(id)) ?? null);
  const onShell = useBackgroundShellsStore((state) => sessionIds.find((id) => state.sessionIds.has(id)) ?? null);
  const onImage = useBackgroundImagesStore((state) => sessionIds.find((id) => state.sessionIds.has(id)) ?? null);
  const onPullRequest = usePrWatchStore((state) => sessionIds.find((id) => state.bySession.has(id)) ?? null);
  return inTurn ?? inWorkflow ?? onShell ?? onImage ?? onPullRequest;
};

/**
 * Every session `useSessionTurnActivity` reads as working, for a consumer that
 * asks about many at once: the running ones, their ancestors, and the sessions
 * waiting on work outside them (a workflow run, a command, a pull request).
 */
export const collectOpenTurnSessionIds = (
  activeSessionIds: ReadonlySet<string>,
  waitingSessionIds: readonly Iterable<string>[],
): ReadonlySet<string> => {
  const open = new Set(activeSessionIds);
  for (const activeId of activeSessionIds) forEachAncestorId(activeId, (ancestorId) => open.add(ancestorId));
  for (const sessionIds of waitingSessionIds) {
    for (const sessionId of sessionIds) open.add(sessionId);
  }
  return open;
};

// The last thing an idle session waited on ending closes its turn, the way the
// last subagent finishing does below. A wake reaches the session before its
// watch ends, so the session then runs on inside the same turn.
const settleSessionsWithoutBackgroundWork = (sessionIds: Iterable<string>, stillWaiting: (sessionId: string) => boolean): void => {
  const { activeSessionIds } = useGlobalSessionStatusStore.getState();
  const timingMutations: SessionActivityTimingMutation[] = [];
  for (const sessionId of sessionIds) {
    if (stillWaiting(sessionId)) continue;
    if (activeSessionIds.has(sessionId) || hasBackgroundWork(sessionId, activeSessionIds)) continue;
    timingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
  }
  applySessionActivityTimingMutations(timingMutations);
};

useBackgroundShellsStore.subscribe((state, previous) => {
  if (state.sessionIds === previous.sessionIds) return;
  settleSessionsWithoutBackgroundWork(previous.sessionIds, (sessionId) => state.sessionIds.has(sessionId));
});

useBackgroundImagesStore.subscribe((state, previous) => {
  if (state.sessionIds === previous.sessionIds) return;
  settleSessionsWithoutBackgroundWork(previous.sessionIds, (sessionId) => state.sessionIds.has(sessionId));
});

usePrWatchStore.subscribe((state, previous) => {
  if (state.bySession === previous.bySession) return;
  settleSessionsWithoutBackgroundWork(previous.bySession.keys(), (sessionId) => state.bySession.has(sessionId));
});

const normalizeStatusType = (type: string | undefined): ActiveStatusType | 'idle' => {
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'idle';
};

const statusesEqual = (left: SessionStatus, right: SessionStatus): boolean => (
  left.type === right.type && JSON.stringify(left) === JSON.stringify(right)
);

// Both write paths normalize the directory key, so a polled snapshot can
// authoritatively replace entries written by events (and vice versa) even when
// the two sources format the same path differently (trailing slash, …).
const normalizeDirectory = (directory: string): string =>
  normalizeProjectPath(directory) ?? directory;

export const getDirectoryOwnedSessionIds = (directory: string, sessions: readonly Session[]): string[] => {
  const scope = normalizeProjectPath(directory);
  if (!scope) return [];
  const ids: string[] = [];
  for (const session of sessions) {
    if (normalizeProjectPath(session.directory) === scope) ids.push(session.id);
  }
  return ids;
};

// Sessions whose status something wrote while an active-list read was in
// flight; that read's answer is older than those writes.
const statusWriteWatchers = new Set<Set<string>>();

const noteStatusWrite = (sessionId: string): void => {
  for (const touched of statusWriteWatchers) touched.add(sessionId);
};

/** Records every session whose status is written until `stop` is called. */
export const watchGlobalSessionStatusWrites = () => {
  const touched = new Set<string>();
  statusWriteWatchers.add(touched);
  return { touched, stop: () => { statusWriteWatchers.delete(touched); } };
};

type ActiveListReconcileDependencies = {
  /** A session written since the read began, or one whose prompt OpenCode has not admitted yet. */
  skip: (sessionId: string) => boolean;
  /** Whether the list answers for sessions of this directory. */
  covers: (directory: string) => boolean;
  resolveDirectory: (sessionId: string) => string | null;
};

/**
 * Status events that bring the index in line with OpenCode's global
 * active-session list. The index is otherwise reconciled only for
 * directories with a store, so a turn that ended in another project while
 * the stream was down kept its row running until a reload. A session the list
 * leaves out is idle now; one it names that the index does not hold is busy,
 * when its directory is known. Neither manufactures a turn outcome.
 */
export const buildActiveListReconcileEvents = (
  activeSessionIds: ReadonlySet<string>,
  deps: ActiveListReconcileDependencies,
): Map<string, SyncEvent[]> => {
  const { statusById } = useGlobalSessionStatusStore.getState();
  const eventsByDirectory = new Map<string, SyncEvent[]>();
  const push = (directory: string, sessionID: string, type: 'idle' | 'busy') => {
    const events = eventsByDirectory.get(directory) ?? [];
    events.push({ type: 'session.status', properties: { sessionID, status: { type } } });
    eventsByDirectory.set(directory, events);
  };
  for (const [sessionId, entry] of statusById) {
    if (activeSessionIds.has(sessionId) || deps.skip(sessionId) || !deps.covers(entry.directory)) continue;
    push(entry.directory, sessionId, 'idle');
  }
  for (const sessionId of activeSessionIds) {
    if (statusById.has(sessionId) || deps.skip(sessionId)) continue;
    const directory = deps.resolveDirectory(sessionId);
    if (!directory || !deps.covers(directory)) continue;
    push(directory, sessionId, 'busy');
  }
  return eventsByDirectory;
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvents = (directory: string, payloads: readonly SyncEvent[]): void => {
  if (payloads.length === 0) return;
  if (statusWriteWatchers.size > 0) {
    for (const payload of payloads) {
      if (payload.type === 'session.status' || payload.type === 'session.idle' || payload.type === 'session.error' || payload.type === 'session.deleted') {
        if (payload.properties.sessionID) noteStatusWrite(payload.properties.sessionID);
      }
    }
  }
  const normalizedDirectory = normalizeDirectory(directory);
  const state = useGlobalSessionStatusStore.getState();
  let statusById: Map<string, GlobalSessionStatusEntry> | null = null;
  let activeSessionIds: Set<string> | null = null;
  let observedById: Map<string, { directory: string; outcome: 'completed' | 'failed' | null }> | null = null;
  const observe = (id: string, outcome: 'completed' | 'failed' | null) => {
    const previous = (observedById ?? state.observedById).get(id);
    // OpenCode may publish idle after an error for the same failed turn.
    const nextOutcome = outcome === 'completed' && previous?.outcome === 'failed' ? 'failed' : outcome;
    if (previous?.directory === normalizedDirectory && previous.outcome === nextOutcome) return;
    observedById ??= new Map(state.observedById);
    observedById.delete(id);
    observedById.set(id, { directory: normalizedDirectory, outcome: nextOutcome });
    if (observedById.size > 2000) {
      const oldest = observedById.keys().next().value;
      if (oldest) observedById.delete(oldest);
    }
  };
  const orderingMutations: SessionOrderingMutation[] = [];
  const timingMutations: SessionActivityTimingMutation[] = [];
  const currentStatuses = (): ReadonlyMap<string, GlobalSessionStatusEntry> => statusById ?? state.statusById;
  const draftStatuses = (): Map<string, GlobalSessionStatusEntry> => (statusById ??= new Map(state.statusById));
  const draftActiveIds = (): Set<string> => (activeSessionIds ??= new Set(state.activeSessionIds));
  const currentActiveIds = (): ReadonlySet<string> => activeSessionIds ?? state.activeSessionIds;
  const notifyTransition = (sessionId: string): void => {
    for (const listener of transitionListeners) listener(sessionId, currentActiveIds());
  };
  const settledIds: string[] = [];
  const settle = (sessionId: string): void => {
    if (currentStatuses().has(sessionId)) {
      draftStatuses().delete(sessionId);
      draftActiveIds().delete(sessionId);
    }
    notifyTransition(sessionId);
    orderingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
    settledIds.push(sessionId);
    // The turn timer keeps running through a background-subagent or background-command pause.
    if (!hasBackgroundWork(sessionId, currentActiveIds())) {
      timingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
    } else {
      timingMutations.push({ type: 'hold', sessionId });
    }
  };

  for (const payload of payloads) {
    if (payload.type === 'session.status') {
      const { sessionID, status, turnStart } = payload.properties;
      if (!sessionID) continue;
      const type = normalizeStatusType(status.type);
      // A status event only records that the session is running again; the
      // outcome of the turn stays whatever the terminal event reported.
      observe(sessionID, type === 'idle' ? (observedById ?? state.observedById).get(sessionID)?.outcome ?? null : null);
      if (type === 'idle') {
        settle(sessionID);
        continue;
      }
      const current = currentStatuses().get(sessionID);
      if (!current || current.directory !== normalizedDirectory || !statusesEqual(current.status, status)) {
        draftStatuses().set(sessionID, { status, directory: normalizedDirectory });
        if (!current) draftActiveIds().add(sessionID);
      }
      notifyTransition(sessionID);
      orderingMutations.push({ type: 'observe', sessionId: sessionID, phase: 'active' });
      timingMutations.push({ type: 'observe', sessionId: sessionID, phase: 'active', turnStart });
      continue;
    }

    if (payload.type === 'session.idle' || payload.type === 'session.error') {
      const { sessionID } = payload.properties;
      if (sessionID) {
        observe(sessionID, payload.type === 'session.error' ? 'failed' : 'completed');
        settle(sessionID);
      }
      continue;
    }

    if (payload.type === 'session.deleted') {
      const { sessionID } = payload.properties;
      if (!sessionID) continue;
      if ((observedById ?? state.observedById).has(sessionID)) {
        observedById ??= new Map(state.observedById);
        observedById.delete(sessionID);
      }
      if (currentStatuses().has(sessionID)) {
        draftStatuses().delete(sessionID);
        draftActiveIds().delete(sessionID);
      }
      orderingMutations.push({ type: 'remove', sessionId: sessionID });
      timingMutations.push({ type: 'remove', sessionId: sessionID });
    }
  }

  // A subagent that finished may have been the last thing holding its
  // parent's turn open.
  const finalActiveIds = currentActiveIds();
  for (const settledId of settledIds) {
    forEachAncestorId(settledId, (ancestorId) => {
      if (finalActiveIds.has(ancestorId) || hasBackgroundWork(ancestorId, finalActiveIds)) return;
      timingMutations.push({ type: 'observe', sessionId: ancestorId, phase: 'settled' });
    });
  }

  if (statusById || observedById) {
    useGlobalSessionStatusStore.setState({
      statusById: statusById ?? state.statusById,
      observedById: observedById ?? state.observedById,
      activeSessionIds: activeSessionIds ?? state.activeSessionIds,
    });
  }
  applySessionOrderingMutations(orderingMutations);
  applySessionActivityTimingMutations(timingMutations);
};

export const applyGlobalSessionStatusEvent = (directory: string, payload: SyncEvent): void => {
  applyGlobalSessionStatusEvents(directory, [payload]);
};

// Polled path: an authoritative `/api/session/active` snapshot. Entries
// missing from the snapshot are idle now — cleared both by directory key and by
// the caller's session-id list (the server may report a canonicalized directory
// that differs from the key an event wrote, e.g. via symlinks). Seeds the
// initial state (events only deliver changes) and reconciles missed events.
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, SessionStatus>,
  knownSessionIds?: Iterable<string>,
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  if (statusWriteWatchers.size > 0) {
    for (const sessionId of known) noteStatusWrite(sessionId);
    for (const sessionId of Object.keys(raw)) noteStatusWrite(sessionId);
    for (const [sessionId, entry] of useGlobalSessionStatusStore.getState().statusById) {
      if (entry.directory === directory) noteStatusWrite(sessionId);
    }
  }
  // Built once as a set and shared by both consumers below; only non-idle
  // sessions land here, so it stays small however long the directory's list is.
  const activeSessionIds = new Set<string>();
  for (const [sessionId, status] of Object.entries(raw)) {
    if (normalizeStatusType(status.type) !== 'idle') activeSessionIds.add(sessionId);
  }
  reconcileSessionActivitySnapshot(activeSessionIds, known);
  // Timing asks the coverage question instead of being handed a list: a snapshot
  // authoritatively covers the caller's session list plus every id it reports
  // itself, and only the handful of sessions actually being timed need an
  // answer. Reuses the sets already built above, so this allocates nothing.
  const turnSessionIds = withBackgroundWork(activeSessionIds);
  const heldSessionIds = new Set<string>();
  for (const sessionId of turnSessionIds) {
    if (!activeSessionIds.has(sessionId)) heldSessionIds.add(sessionId);
  }
  reconcileSessionActivityTiming(
    turnSessionIds,
    (sessionId) => known.has(sessionId) || sessionId in raw,
    heldSessionIds,
  );
  useGlobalSessionStatusStore.setState((state) => {
    let changed = false;
    let observedById: Map<string, { directory: string; outcome: 'completed' | 'failed' | null }> | null = null;
    const next = new Map(state.statusById);
    let nextActiveSessionIds: Set<string> | null = null;
    const hasActiveSession = (sessionId: string): boolean => (
      (nextActiveSessionIds ?? state.activeSessionIds).has(sessionId)
    );
    const removeActiveSession = (sessionId: string): void => {
      if (!hasActiveSession(sessionId)) return;
      nextActiveSessionIds ??= new Set(state.activeSessionIds);
      nextActiveSessionIds.delete(sessionId);
    };
    const addActiveSession = (sessionId: string): void => {
      if (hasActiveSession(sessionId)) return;
      nextActiveSessionIds ??= new Set(state.activeSessionIds);
      nextActiveSessionIds.add(sessionId);
    };

    for (const [sessionId, entry] of state.statusById) {
      if ((entry.directory === directory || known.has(sessionId)) && !(sessionId in raw)) {
        next.delete(sessionId);
        removeActiveSession(sessionId);
        changed = true;
      }
    }

    for (const [sessionId, status] of Object.entries(raw)) {
      const type = normalizeStatusType(status.type);
      const observed = state.observedById.get(sessionId);
      if (type !== 'idle' && observed?.outcome) {
        observedById ??= new Map(state.observedById);
        observedById.set(sessionId, { directory, outcome: null });
      }
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          removeActiveSession(sessionId);
          changed = true;
        }
        continue;
      }
      if (!current || current.directory !== directory || !statusesEqual(current.status, status)) {
        next.set(sessionId, { status, directory });
        if (!current) addActiveSession(sessionId);
        changed = true;
      }
    }

    return changed || observedById ? {
      observedById: observedById ?? state.observedById,
      statusById: next,
      activeSessionIds: nextActiveSessionIds ?? state.activeSessionIds,
    } : state;
  });
};
