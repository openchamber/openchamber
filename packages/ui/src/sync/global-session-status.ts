import { create } from 'zustand';
import type { Event, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  observeSessionActivityEvent,
  reconcileSessionActivitySnapshot,
  removeSessionOrdering,
} from './session-ordering';
import {
  observeSessionActivityTiming,
  reconcileSessionActivityTiming,
  removeSessionActivityTiming,
} from './session-activity-timing';

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
  /** False while a runtime boundary is waiting for its first new snapshot. */
  acceptEventUpdates: boolean;
  /**
   * True when the last status fetch failed or the runtime is temporarily
   * unreachable (transient HTTP failure, 502, network/SSE disconnect,
   * transport switch). Status data is preserved as last known but should be
   * presented as "temporarily unavailable/reconnecting", NOT as idle. A
   * successful authoritative snapshot clears it.
   *
   * This is distinct from `acceptEventUpdates`, which gates the runtime
   * boundary: `acceptEventUpdates: false` means a real runtime replacement
   * (issue #2421) and old data was cleared; `statusUnavailable: true` means a
   * transient transport/fetch problem and old data is preserved.
   */
  statusUnavailable: boolean;
};

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => ({
  statusById: new Map(),
  acceptEventUpdates: true,
  statusUnavailable: false,
}));

/**
 * Clear all live status evidence when the active OpenCode runtime is replaced.
 * Used by the real-runtime-replacement path (issue #2421): stale activity from
 * the old runtime must not be presented as current. This intentionally does
 * not touch the global session cache or any durable session/message state,
 * and marks status as fresh (a clean reset, not a transient failure).
 */
export const resetGlobalSessionStatus = (options?: { blockEventUpdates?: boolean }): void => {
  useGlobalSessionStatusStore.setState({
    statusById: new Map(),
    acceptEventUpdates: options?.blockEventUpdates !== true,
    statusUnavailable: false,
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

const setStatus = (sessionId: string, directory: string, status: SessionStatus | { type: 'idle' }): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const current = state.statusById.get(sessionId);
    if (status.type === 'idle') {
      if (!current) return state;
      const next = new Map(state.statusById);
      next.delete(sessionId);
      return { statusById: next };
    }
    if (current && current.directory === directory && statusesEqual(current.status, status)) return state;
    const next = new Map(state.statusById);
    next.set(sessionId, { status, directory });
    return { statusById: next };
  });
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvent = (directory: string, payload: Event): void => {
  if (!areGlobalSessionStatusEventsEnabled()) return;

  switch (payload.type) {
    case 'session.status': {
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      if (typeof props?.sessionID !== 'string' || !props.sessionID) return;
      const type = normalizeStatusType(props.status?.type);
      setStatus(
        props.sessionID,
        normalizeDirectory(directory),
        type === 'idle' ? { type: 'idle' } : { ...(props.status ?? {}), type } as SessionStatus,
      );
      observeSessionActivityEvent(props.sessionID, type === 'idle' ? 'settled' : 'active');
      // `retry` is still a running turn, so the elapsed counter keeps going.
      observeSessionActivityTiming(props.sessionID, type === 'idle' ? 'settled' : 'active');
      return;
    }
    case 'session.idle':
    case 'session.error': {
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) {
        setStatus(props.sessionID, normalizeDirectory(directory), { type: 'idle' });
        observeSessionActivityEvent(props.sessionID, 'settled');
        observeSessionActivityTiming(props.sessionID, 'settled');
      }
      return;
    }
    case 'session.deleted': {
      const props = payload.properties as { sessionID?: string; info?: { id?: string } } | undefined;
      const sessionId = props?.sessionID ?? props?.info?.id;
      if (sessionId) {
        setStatus(sessionId, normalizeDirectory(directory), { type: 'idle' });
        observeSessionActivityEvent(sessionId, 'settled');
        removeSessionOrdering(sessionId);
        removeSessionActivityTiming(sessionId);
      }
      return;
    }
    default:
      return;
  }
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

    for (const [sessionId, entry] of state.statusById) {
      if ((entry.directory === directory || known.has(sessionId)) && !(sessionId in raw)) {
        next.delete(sessionId);
        changed = true;
      }
    }

    for (const [sessionId, status] of Object.entries(raw)) {
      const type = normalizeStatusType(status?.type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          changed = true;
        }
        continue;
      }
      const normalizedStatus = { ...status, type } as SessionStatus;
      if (!current || current.directory !== directory || !statusesEqual(current.status, normalizedStatus)) {
        next.set(sessionId, { status: normalizedStatus, directory });
        changed = true;
      }
    }

    // A fresh authoritative snapshot arrived: re-enable event updates and clear
    // any transient unavailability flag. Either condition forces a re-render so
    // consumers stop showing "reconnecting" and see the fresh live state.
    if (!state.acceptEventUpdates) changed = true;
    if (state.statusUnavailable) changed = true;
    return changed ? { statusById: next, acceptEventUpdates: true, statusUnavailable: false } : state;
  });
};

/**
 * A failed status request is not an authoritative empty snapshot and must not
 * be treated as one. A transient HTTP failure, 502, network interruption, relay
 * interruption, or temporary SSE disconnect does not prove the underlying
 * OpenCode session became idle.
 *
 * This preserves the last known status data (busy/retry entries stay in
 * `statusById`) and only sets the global `statusUnavailable` freshness flag so
 * consumers can present the state as "temporarily unavailable/reconnecting"
 * instead of as a confirmed active spinner or as idle. It does NOT delete
 * entries, does NOT call `reconcileSessionActivitySnapshot([], known)` (that
 * would clear ordering as if idle), and does NOT call `removeSessionOrdering`.
 *
 * The flag is global: every consumer observes the same freshness. The next
 * successful authoritative snapshot (`applyGlobalSessionStatusSnapshot`) clears
 * it with fresh data. A real runtime replacement uses
 * `resetGlobalSessionStatus({ blockEventUpdates: true })` instead, which does
 * destroy stale data and blocks old events.
 */
export const markGlobalSessionStatusUnavailable = (): void => {
  useGlobalSessionStatusStore.setState((state) => (
    state.statusUnavailable ? state : { statusUnavailable: true }
  ));
};
