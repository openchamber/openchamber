import { useMemo } from 'react';
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
import { useBackgroundShellsStore } from './background-shells';
import { useBackgroundImagesStore } from './background-images';
import { useWorkflowActivityStore } from './workflow-activity';
import { usePrWatchStore } from './pr-watch';
import { useExtensionWaitsStore } from './extension-waits';


type ActiveStatusType = 'busy' | 'retry';

type GlobalSessionStatusEntry = { status: SessionStatus; directory: string };

type GlobalSessionStatusState = {
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

export const subscribeSessionStatusTransitions = (listener: SessionStatusTransitionListener): (() => void) => {
  transitionListeners.add(listener);
  return () => { transitionListeners.delete(listener); };
};

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

type SessionParentResolver = (sessionId: string) => string | undefined;
let resolveSessionParentId: SessionParentResolver = () => undefined;

export const setSessionParentResolver = (resolver: SessionParentResolver): void => {
  resolveSessionParentId = resolver;
};

const MAX_SUBAGENT_DEPTH = 8;

const forEachAncestorId = (sessionId: string, visit: (ancestorId: string) => void, resolveParentId: SessionParentResolver = resolveSessionParentId): void => {
  let current = resolveParentId(sessionId);
  for (let depth = 0; current && depth < MAX_SUBAGENT_DEPTH; depth += 1) {
    visit(current);
    current = resolveParentId(current);
  }
};

const hasDescendantIn = (
  sessionId: string,
  candidateIds: Iterable<string>,
  resolveParentId: SessionParentResolver = resolveSessionParentId,
): boolean => {
  for (const candidateId of candidateIds) {
    if (candidateId === sessionId) continue;
    let found = false;
    forEachAncestorId(candidateId, (ancestorId) => {
      if (ancestorId === sessionId) found = true;
    }, resolveParentId);
    if (found) return true;
  }
  return false;
};

const hasSelfOrDescendant = (
  sessionId: string,
  candidates: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  resolveParentId: SessionParentResolver = resolveSessionParentId,
): boolean => (
  candidates.size > 0 && (candidates.has(sessionId) || hasDescendantIn(sessionId, candidates.keys(), resolveParentId))
);

export const anySessionOrDescendantIn = (
  sessionIds: ReadonlySet<string>,
  candidates: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  resolveParentId: SessionParentResolver = resolveSessionParentId,
): boolean => {
  if (sessionIds.size === 0 || candidates.size === 0) return false;
  for (const candidateId of candidates.keys()) {
    if (sessionIds.has(candidateId)) return true;
    let found = false;
    forEachAncestorId(candidateId, (ancestorId) => {
      if (sessionIds.has(ancestorId)) found = true;
    }, resolveParentId);
    if (found) return true;
  }
  return false;
};

export const hasActiveSubagent = (
  sessionId: string,
  activeSessionIds: ReadonlySet<string>,
  resolveParentId: SessionParentResolver = resolveSessionParentId,
): boolean => activeSessionIds.size > 0 && hasDescendantIn(sessionId, activeSessionIds, resolveParentId);

const withBackgroundWork = (activeSessionIds: ReadonlySet<string>): ReadonlySet<string> => {
  let extended: Set<string> | null = null;
  const add = (sessionId: string): void => {
    if (activeSessionIds.has(sessionId)) return;
    extended ??= new Set(activeSessionIds);
    extended.add(sessionId);
  };
  const addWithAncestors = (sessionId: string): void => {
    add(sessionId);
    forEachAncestorId(sessionId, add);
  };
  for (const activeId of activeSessionIds) forEachAncestorId(activeId, add);
  for (const sessionId of useWorkflowActivityStore.getState().runningSessionIds) addWithAncestors(sessionId);
  for (const sessionId of useBackgroundShellsStore.getState().sessionIds) addWithAncestors(sessionId);
  for (const sessionId of useBackgroundImagesStore.getState().sessionIds) addWithAncestors(sessionId);
  for (const sessionId of usePrWatchStore.getState().bySession.keys()) addWithAncestors(sessionId);
  for (const sessionId of useExtensionWaitsStore.getState().bySession.keys()) addWithAncestors(sessionId);
  return extended ?? activeSessionIds;
};

export const hasBackgroundWork = (sessionId: string, activeSessionIds: ReadonlySet<string>): boolean => (
  hasActiveSubagent(sessionId, activeSessionIds)
  || hasSelfOrDescendant(sessionId, useWorkflowActivityStore.getState().runningSessionIds)
  || hasSelfOrDescendant(sessionId, useBackgroundShellsStore.getState().sessionIds)
  || hasSelfOrDescendant(sessionId, useBackgroundImagesStore.getState().sessionIds)
  || hasSelfOrDescendant(sessionId, usePrWatchStore.getState().bySession)
  || hasSelfOrDescendant(sessionId, useExtensionWaitsStore.getState().bySession)
);

type SessionTurnActivity = 'running' | 'workflow' | 'subagent' | 'shell' | 'image' | 'pullRequest' | 'extensionWait';

export const resolveSessionTurnActivity = (
  status: 'running' | 'subagent' | null,
  workflowRunning: boolean,
  waitingOnShell: boolean,
  waitingOnPullRequest = false,
  waitingOnImage = false,
  waitingOnExtension = false,
): SessionTurnActivity | null => {
  if (status === 'running') return status;
  if (workflowRunning) return 'workflow';
  if (status) return status;
  if (waitingOnShell) return 'shell';
  if (waitingOnImage) return 'image';
  if (waitingOnPullRequest) return 'pullRequest';
  return waitingOnExtension ? 'extensionWait' : null;
};

export const useSessionTurnActivity = (sessionId: string): SessionTurnActivity | null => {
  const status = useGlobalSessionStatusStore((state): 'running' | 'subagent' | null => {
    if (state.activeSessionIds.has(sessionId)) return 'running';
    return hasActiveSubagent(sessionId, state.activeSessionIds) ? 'subagent' : null;
  });
  const workflowRunning = useWorkflowActivityStore((state) => (
    status === 'running' ? false : hasSelfOrDescendant(sessionId, state.runningSessionIds)
  ));
  const skipLower = status !== null || workflowRunning;
  const waitingOnShell = useBackgroundShellsStore((state) => (
    skipLower ? false : hasSelfOrDescendant(sessionId, state.sessionIds)
  ));
  const waitingOnImage = useBackgroundImagesStore((state) => (
    skipLower || waitingOnShell ? false : hasSelfOrDescendant(sessionId, state.sessionIds)
  ));
  const waitingOnPullRequest = usePrWatchStore((state) => (
    skipLower || waitingOnShell || waitingOnImage ? false : hasSelfOrDescendant(sessionId, state.bySession)
  ));
  const waitingOnExtension = useExtensionWaitsStore((state) => (
    skipLower || waitingOnShell || waitingOnImage || waitingOnPullRequest
      ? false
      : hasSelfOrDescendant(sessionId, state.bySession)
  ));
  return resolveSessionTurnActivity(status, workflowRunning, waitingOnShell, waitingOnPullRequest, waitingOnImage, waitingOnExtension);
};

export const useFirstSessionWithOpenTurn = (sessionIds: readonly string[]): string | null => {
  const inTurn = useGlobalSessionStatusStore((state) => (
    sessionIds.find((id) => state.activeSessionIds.has(id) || hasActiveSubagent(id, state.activeSessionIds)) ?? null
  ));
  const inWorkflow = useWorkflowActivityStore((state) => (
    inTurn ? null : sessionIds.find((id) => hasSelfOrDescendant(id, state.runningSessionIds)) ?? null
  ));
  const onShell = useBackgroundShellsStore((state) => (
    inTurn || inWorkflow ? null : sessionIds.find((id) => hasSelfOrDescendant(id, state.sessionIds)) ?? null
  ));
  const onImage = useBackgroundImagesStore((state) => (
    inTurn || inWorkflow || onShell ? null : sessionIds.find((id) => hasSelfOrDescendant(id, state.sessionIds)) ?? null
  ));
  const onPullRequest = usePrWatchStore((state) => (
    inTurn || inWorkflow || onShell || onImage ? null : sessionIds.find((id) => hasSelfOrDescendant(id, state.bySession)) ?? null
  ));
  const onExtension = useExtensionWaitsStore((state) => (
    inTurn || inWorkflow || onShell || onImage || onPullRequest
      ? null
      : sessionIds.find((id) => hasSelfOrDescendant(id, state.bySession)) ?? null
  ));
  return inTurn ?? inWorkflow ?? onShell ?? onImage ?? onPullRequest ?? onExtension;
};

const joinMatching = (sessionIds: readonly string[], match: (sessionId: string) => boolean): string => {
  let result = '';
  for (const sessionId of sessionIds) {
    if (!match(sessionId)) continue;
    result = result ? `${result}\n${sessionId}` : sessionId;
  }
  return result;
};

const EMPTY_BACKGROUND_WORK_IDS: ReadonlySet<string> = new Set();

export const useBackgroundWorkSessionIds = (sessionIds: readonly string[]): ReadonlySet<string> => {
  const withSubagent = useGlobalSessionStatusStore((state) => (
    joinMatching(sessionIds, (id) => hasActiveSubagent(id, state.activeSessionIds))
  ));
  const withWorkflow = useWorkflowActivityStore((state) => (
    joinMatching(sessionIds, (id) => hasSelfOrDescendant(id, state.runningSessionIds))
  ));
  const withShell = useBackgroundShellsStore((state) => (
    joinMatching(sessionIds, (id) => hasSelfOrDescendant(id, state.sessionIds))
  ));
  const withImage = useBackgroundImagesStore((state) => (
    joinMatching(sessionIds, (id) => hasSelfOrDescendant(id, state.sessionIds))
  ));
  const withPullRequest = usePrWatchStore((state) => (
    joinMatching(sessionIds, (id) => hasSelfOrDescendant(id, state.bySession))
  ));
  const withExtension = useExtensionWaitsStore((state) => (
    joinMatching(sessionIds, (id) => hasSelfOrDescendant(id, state.bySession))
  ));
  return useMemo(() => {
    if (!withSubagent && !withWorkflow && !withShell && !withImage && !withPullRequest && !withExtension) {
      return EMPTY_BACKGROUND_WORK_IDS;
    }
    const ids = new Set<string>();
    for (const joined of [withSubagent, withWorkflow, withShell, withImage, withPullRequest, withExtension]) {
      if (!joined) continue;
      for (const id of joined.split('\n')) ids.add(id);
    }
    return ids;
  }, [withExtension, withImage, withPullRequest, withShell, withSubagent, withWorkflow]);
};

export const collectOpenTurnSessionIds = (
  activeSessionIds: ReadonlySet<string>,
  waitingSessionIds: readonly Iterable<string>[],
): ReadonlySet<string> => {
  const open = new Set(activeSessionIds);
  const addAncestors = (sessionId: string): void => forEachAncestorId(sessionId, (ancestorId) => open.add(ancestorId));
  for (const activeId of activeSessionIds) addAncestors(activeId);
  for (const sessionIds of waitingSessionIds) {
    for (const sessionId of sessionIds) {
      open.add(sessionId);
      addAncestors(sessionId);
    }
  }
  return open;
};

const settleSessionsWithoutBackgroundWork = (sessionIds: Iterable<string>, stillWaiting: (sessionId: string) => boolean): void => {
  const { activeSessionIds } = useGlobalSessionStatusStore.getState();
  const candidates = new Set<string>();
  for (const sessionId of sessionIds) {
    if (stillWaiting(sessionId)) continue;
    candidates.add(sessionId);
    forEachAncestorId(sessionId, (ancestorId) => candidates.add(ancestorId));
  }
  const timingMutations: SessionActivityTimingMutation[] = [];
  for (const sessionId of candidates) {
    if (activeSessionIds.has(sessionId) || hasBackgroundWork(sessionId, activeSessionIds)) continue;
    timingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
  }
  applySessionActivityTimingMutations(timingMutations);
};

useWorkflowActivityStore.subscribe((state, previous) => {
  if (state.runningSessionIds === previous.runningSessionIds) return;
  settleSessionsWithoutBackgroundWork(previous.runningSessionIds, (sessionId) => state.runningSessionIds.has(sessionId));
});

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

useExtensionWaitsStore.subscribe((state, previous) => {
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

const statusWriteWatchers = new Set<Set<string>>();

const noteStatusWrite = (sessionId: string): void => {
  for (const touched of statusWriteWatchers) touched.add(sessionId);
};

export const watchGlobalSessionStatusWrites = () => {
  const touched = new Set<string>();
  statusWriteWatchers.add(touched);
  return { touched, stop: () => { statusWriteWatchers.delete(touched); } };
};

type ActiveListReconcileDependencies = {
  skip: (sessionId: string) => boolean;
  covers: (directory: string) => boolean;
  resolveDirectory: (sessionId: string) => string | null;
};

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
  const activeSessionIds = new Set<string>();
  for (const [sessionId, status] of Object.entries(raw)) {
    if (normalizeStatusType(status.type) !== 'idle') activeSessionIds.add(sessionId);
  }
  reconcileSessionActivitySnapshot(activeSessionIds, known);
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
