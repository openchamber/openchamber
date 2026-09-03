import { create } from 'zustand';
import type { Event, SessionStatus } from '@opencode-ai/sdk/v2/client';
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
// Only non-idle entries are kept; absence means idle. Entries carry their
// directory so a polled per-directory snapshot can authoritatively replace
// that directory's slice (the server omits idle sessions from snapshots).

type ActiveStatusType = 'busy' | 'retry';

type GlobalSessionStatusEntry = { status: SessionStatus; directory: string };

type GlobalSessionStatusState = {
  statusById: Map<string, GlobalSessionStatusEntry>;
  activeSessionIds: ReadonlySet<string>;
  /** False while a runtime boundary is waiting for its first new snapshot. */
  acceptEventUpdates: boolean;
  /**
   * Directories whose last `/session/status?directory=X` fetch failed or
   * whose status data is otherwise temporarily unavailable. Freshness is
   * scoped to the status authority that produced the data: a failed fetch
   * for `/repo-a` marks only `/repo-a` unavailable, so a concurrent
   * successful snapshot for `/repo-b` cannot make `/repo-a`'s preserved
   * busy/retry entries appear fresh again.
   *
   * A transport-wide disconnect or transport switch populates this set with
   * every currently known directory (from `statusById` entries). Each
   * directory's freshness is then restored independently when its own next
   * successful authoritative snapshot arrives — a successful snapshot for
   * one directory does NOT implicitly freshen another.
   *
   * Uses the same normalized directory keys as `statusById` entries.
   */
  unavailableDirectories: Set<string>;
};

const EMPTY_ACTIVE_SESSION_IDS: ReadonlySet<string> = new Set();

const initialState: GlobalSessionStatusState = {
  statusById: new Map(),
  activeSessionIds: EMPTY_ACTIVE_SESSION_IDS,
  acceptEventUpdates: true,
  unavailableDirectories: new Set(),
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
    statusById,
    activeSessionIds: sameMembership ? current.activeSessionIds : nextActiveSessionIds,
  });
};

export const resetGlobalSessionStatus = (options?: { blockEventUpdates?: boolean }): void => {
  useGlobalSessionStatusStore.setState({
    statusById: new Map(),
    activeSessionIds: EMPTY_ACTIVE_SESSION_IDS,
    acceptEventUpdates: options?.blockEventUpdates !== true,
    unavailableDirectories: new Set(),
  });
};

export const areGlobalSessionStatusEventsEnabled = (): boolean => (
  useGlobalSessionStatusStore.getState().acceptEventUpdates !== false
);

const normalizeStatusType = (type: unknown): ActiveStatusType | 'idle' => {
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

/**
 * Check whether a session's status data is currently fresh (not unavailable).
 * Freshness is determined from the session's own directory: a failed fetch for
 * `/repo-a` does not make `/repo-b`'s status stale.
 *
 * The `directory` parameter is required because `statusById` intentionally
 * stores only busy/retry entries — absence means "last known was idle", NOT
 * "definitely idle right now while the directory is unavailable". A session
 * with no active-status entry whose directory is unavailable must NOT be
 * treated as fresh for control decisions.
 */
export const isSessionStatusFresh = (sessionId: string, directory: string): boolean => {
  const state = useGlobalSessionStatusStore.getState();
  const normalized = normalizeDirectory(directory);
  return !state.unavailableDirectories.has(normalized);
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvents = (directory: string, payloads: readonly Event[]): void => {
  if (payloads.length === 0 || !areGlobalSessionStatusEventsEnabled()) return;
  const normalizedDirectory = normalizeDirectory(directory);
  const state = useGlobalSessionStatusStore.getState();
  let statusById: Map<string, GlobalSessionStatusEntry> | null = null;
  let activeSessionIds: Set<string> | null = null;
  const orderingMutations: SessionOrderingMutation[] = [];
  const timingMutations: SessionActivityTimingMutation[] = [];
  const currentStatuses = (): ReadonlyMap<string, GlobalSessionStatusEntry> => statusById ?? state.statusById;
  const draftStatuses = (): Map<string, GlobalSessionStatusEntry> => (statusById ??= new Map(state.statusById));
  const draftActiveIds = (): Set<string> => (activeSessionIds ??= new Set(state.activeSessionIds));
  const settle = (sessionId: string): void => {
    if (currentStatuses().has(sessionId)) {
      draftStatuses().delete(sessionId);
      draftActiveIds().delete(sessionId);
    }
    orderingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
    timingMutations.push({ type: 'observe', sessionId, phase: 'settled' });
  };

  for (const payload of payloads) {
    if (payload.type === 'session.status') {
      // SAFETY: OpenCode event properties for this event contain the optional session ID and status payload.
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      if (typeof props?.sessionID !== 'string' || !props.sessionID) continue;
      const type = normalizeStatusType(props.status?.type);
      if (type === 'idle') {
        settle(props.sessionID);
        continue;
      }
      // SAFETY: the normalized discriminator is one of the SDK's active status types.
      const status = { ...(props.status ?? {}), type } as SessionStatus;
      const current = currentStatuses().get(props.sessionID);
      if (!current || current.directory !== normalizedDirectory || !statusesEqual(current.status, status)) {
        draftStatuses().set(props.sessionID, { status, directory: normalizedDirectory });
        if (!current) draftActiveIds().add(props.sessionID);
      }
      orderingMutations.push({ type: 'observe', sessionId: props.sessionID, phase: 'active' });
      timingMutations.push({ type: 'observe', sessionId: props.sessionID, phase: 'active' });
      continue;
    }

    if (payload.type === 'session.idle' || payload.type === 'session.error') {
      // SAFETY: OpenCode terminal event properties contain the optional addressed session ID.
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) settle(props.sessionID);
      continue;
    }

    if (payload.type === 'session.deleted') {
      // SAFETY: OpenCode deletion event properties identify the deleted session directly or through info.id.
      const props = payload.properties as { sessionID?: string; info?: { id?: string } } | undefined;
      const sessionId = props?.sessionID ?? props?.info?.id;
      if (!sessionId) continue;
      if (currentStatuses().has(sessionId)) {
        draftStatuses().delete(sessionId);
        draftActiveIds().delete(sessionId);
      }
      orderingMutations.push({ type: 'remove', sessionId });
      timingMutations.push({ type: 'remove', sessionId });
    }
  }

  if (statusById) {
    useGlobalSessionStatusStore.setState({
      statusById,
      activeSessionIds: activeSessionIds ?? state.activeSessionIds,
    });
  }
  applySessionOrderingMutations(orderingMutations);
  applySessionActivityTimingMutations(timingMutations);
};

export const applyGlobalSessionStatusEvent = (directory: string, payload: Event): void => {
  applyGlobalSessionStatusEvents(directory, [payload]);
};

// Polled path: an authoritative `/session/status?directory=X` snapshot. Entries
// missing from the snapshot are idle now — cleared both by directory key and by
// the caller's session-id list (the server may report a canonicalized directory
// that differs from the key an event wrote, e.g. via symlinks). Seeds the
// initial state (events only deliver changes) and reconciles missed events.
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, { type?: string }>,
  knownSessionIds?: Iterable<string>,
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  for (const [sessionId, entry] of useGlobalSessionStatusStore.getState().statusById) {
    if (entry.directory === directory) known.add(sessionId);
  }
  // Built once as a set and shared by both consumers below; only non-idle
  // sessions land here, so it stays small however long the directory's list is.
  const activeSessionIds = new Set<string>();
  for (const [sessionId, status] of Object.entries(raw)) {
    if (normalizeStatusType(status?.type) !== 'idle') activeSessionIds.add(sessionId);
  }
  reconcileSessionActivitySnapshot(activeSessionIds, known);
  // Timing asks the coverage question instead of being handed a list: a snapshot
  // authoritatively covers the caller's session list plus every id it reports
  // itself, and only the handful of sessions actually being timed need an
  // answer. Reuses the sets already built above, so this allocates nothing.
  reconcileSessionActivityTiming(
    activeSessionIds,
    (sessionId) => known.has(sessionId) || sessionId in raw,
  );
  useGlobalSessionStatusStore.setState((state) => {
    let changed = false;
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
      const type = normalizeStatusType(status?.type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          removeActiveSession(sessionId);
          changed = true;
        }
        continue;
      }
      // SAFETY: normalizeStatusType has narrowed this snapshot entry to the SDK's busy/retry status discriminator.
      const normalizedStatus = { ...status, type } as SessionStatus;
      if (!current || current.directory !== directory || !statusesEqual(current.status, normalizedStatus)) {
        next.set(sessionId, { status: normalizedStatus, directory });
        if (!current) addActiveSession(sessionId);
        changed = true;
      }
    }

    // A fresh authoritative snapshot for this directory arrived: re-enable
    // event updates and clear this directory's unavailable flag. Only this
    // directory's freshness is cleared — a concurrent failure in another
    // directory must not be freshened by this snapshot.
    if (!state.acceptEventUpdates) changed = true;
    if (state.unavailableDirectories.has(directory)) changed = true;
    const nextUnavailable = new Set(state.unavailableDirectories);
    nextUnavailable.delete(directory);
    return changed
      ? {
        statusById: next,
        activeSessionIds: nextActiveSessionIds ?? state.activeSessionIds,
        acceptEventUpdates: true,
        unavailableDirectories: nextUnavailable,
      }
      : state;
  });
};

/**
 * A failed status request for a specific directory is not an authoritative
 * empty snapshot and must not be treated as one. A transient HTTP failure,
 * 502, network interruption, relay interruption, or temporary SSE disconnect
 * does not prove the underlying OpenCode session became idle.
 *
 * This preserves the last known status data (busy/retry entries stay in
 * `statusById`) and marks only the given directory as unavailable so
 * consumers can present the state as "temporarily unavailable/reconnecting"
 * instead of as a confirmed active spinner or as idle. It does NOT delete
 * entries, does NOT call `reconcileSessionActivitySnapshot([], known)` (that
 * would clear ordering as if idle), and does NOT call `removeSessionOrdering`.
 *
 * Freshness is directory-scoped: a failed fetch for `/repo-a` does not mark
 * `/repo-b` unavailable. A successful snapshot for `/repo-b` does not clear
 * `/repo-a`'s unavailable flag.
 */
export const markDirectoryStatusUnavailable = (rawDirectory: string): void => {
  const directory = normalizeDirectory(rawDirectory);
  useGlobalSessionStatusStore.setState((state) => {
    if (state.unavailableDirectories.has(directory)) return state;
    const next = new Set(state.unavailableDirectories);
    next.add(directory);
    return { unavailableDirectories: next };
  });
};

/**
 * Mark every currently known directory as temporarily unavailable after a
 * transport-wide disconnect or transport switch. This is distinct from a
 * per-directory fetch failure: a transport disconnect affects all
 * directories deterministically.
 *
 * Populates `unavailableDirectories` with every directory that has an entry in
 * `statusById`, so each directory's freshness is restored independently when
 * its own next successful authoritative snapshot arrives — a successful
 * snapshot for one directory does NOT implicitly freshen another.
 *
 * `knownDirectories` may be passed to include directories that have no active
 * `statusById` entry (e.g. directories with only idle sessions). This ensures
 * freshness can be determined even for idle sessions whose directory is
 * unavailable.
 */
export const markTransportStatusUnavailable = (knownDirectories?: Iterable<string>): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const next = new Set(state.unavailableDirectories);
    for (const entry of state.statusById.values()) {
      next.add(entry.directory);
    }
    if (knownDirectories) {
      for (const dir of knownDirectories) {
        next.add(normalizeDirectory(dir));
      }
    }
    if (next.size === state.unavailableDirectories.size) {
      // Check if contents are identical
      let same = true;
      for (const d of next) { if (!state.unavailableDirectories.has(d)) { same = false; break; } }
      if (same) return state;
    }
    return { unavailableDirectories: next };
  });
};
