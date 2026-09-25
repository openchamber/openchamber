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

const forEachAncestorId = (sessionId: string, visit: (ancestorId: string) => void): void => {
  let current = resolveSessionParentId(sessionId);
  for (let depth = 0; current && depth < MAX_SUBAGENT_DEPTH; depth += 1) {
    visit(current);
    current = resolveSessionParentId(current);
  }
};

/** True when a subagent anywhere below the session is running. */
export const hasActiveSubagent = (sessionId: string, activeSessionIds: ReadonlySet<string>): boolean => {
  for (const activeId of activeSessionIds) {
    if (activeId === sessionId) continue;
    let found = false;
    forEachAncestorId(activeId, (ancestorId) => {
      if (ancestorId === sessionId) found = true;
    });
    if (found) return true;
  }
  return false;
};

/** Active sessions plus every ancestor whose turn they keep open. */
const withSubagentAncestors = (activeSessionIds: ReadonlySet<string>): ReadonlySet<string> => {
  let extended: Set<string> | null = null;
  for (const activeId of activeSessionIds) {
    forEachAncestorId(activeId, (ancestorId) => {
      if (activeSessionIds.has(ancestorId)) return;
      extended ??= new Set(activeSessionIds);
      extended.add(ancestorId);
    });
  }
  return extended ?? activeSessionIds;
};

/** The session's turn is still open: it runs itself, or one of its subagents does. */
export const useSessionTurnActive = (sessionId: string): boolean => useGlobalSessionStatusStore(
  (state) => state.activeSessionIds.has(sessionId) || hasActiveSubagent(sessionId, state.activeSessionIds),
);

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

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvents = (directory: string, payloads: readonly SyncEvent[]): void => {
  if (payloads.length === 0) return;
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
  const settledIds: string[] = [];
  const settle = (sessionId: string): void => {
    if (currentStatuses().has(sessionId)) {
      draftStatuses().delete(sessionId);
      draftActiveIds().delete(sessionId);
    }
    orderingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
    settledIds.push(sessionId);
    // The turn timer keeps running through a background-subagent pause.
    if (!hasActiveSubagent(sessionId, currentActiveIds())) {
      timingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
    }
  };

  for (const payload of payloads) {
    if (payload.type === 'session.status') {
      const { sessionID, status } = payload.properties;
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
      orderingMutations.push({ type: 'observe', sessionId: sessionID, phase: 'active' });
      timingMutations.push({ type: 'observe', sessionId: sessionID, phase: 'active' });
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
      if (finalActiveIds.has(ancestorId) || hasActiveSubagent(ancestorId, finalActiveIds)) return;
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
  reconcileSessionActivityTiming(
    withSubagentAncestors(activeSessionIds),
    (sessionId) => known.has(sessionId) || sessionId in raw,
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
