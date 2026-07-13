/**
 * Memoized selectors for the multi-host store.
 *
 * Every selector returns stable references when the underlying slice has not
 * changed, so React consumers re-render only when their data actually changes.
 */

import { useMultiHostStore, type HostRuntimeState } from './multi-host-store';
import type { HostId, HostProjectSummary, HostSessionRef, HostSessionStatus, HostSessionSummary } from './types';

// ---------------------------------------------------------------------------
// Stable empty values for referential stability
// ---------------------------------------------------------------------------

const EMPTY_SESSIONS: Record<string, HostSessionSummary> = {};
const EMPTY_PROJECTS: HostProjectSummary[] = [];

// ---------------------------------------------------------------------------
// Primitive selectors
// ---------------------------------------------------------------------------

/** Select a single host's runtime state. */
export const selectHost = (hostId: HostId): HostRuntimeState | undefined =>
  useMultiHostStore.getState().hosts[hostId];

/** Select all hosts as a record. */
export const selectHosts = (): Record<string, HostRuntimeState> =>
  useMultiHostStore.getState().hosts;

// ---------------------------------------------------------------------------
// Derived selectors (return stable references when inputs are unchanged)
// ---------------------------------------------------------------------------

/** Select the sessions map for a host. */
export const selectHostSessions = (hostId: HostId): Record<string, HostSessionSummary> => {
  const host = useMultiHostStore.getState().hosts[hostId];
  return host?.sessions ?? EMPTY_SESSIONS;
};

/** Select the projects list for a host. */
export const selectHostProjects = (hostId: HostId): HostRuntimeState['projects'] => {
  const host = useMultiHostStore.getState().hosts[hostId];
  return host?.projects ?? EMPTY_PROJECTS;
};

/** Look up a session by its scoped ref (hostId + sessionId). */
export const selectSessionByRef = (ref: HostSessionRef): HostSessionSummary | undefined => {
  const host = useMultiHostStore.getState().hosts[ref.hostId];
  return host?.sessions[ref.sessionId];
};

/** Look up session status by its scoped ref. */
export const selectSessionStatusByRef = (ref: HostSessionRef): HostSessionStatus | undefined => {
  const host = useMultiHostStore.getState().hosts[ref.hostId];
  return host?.statuses[ref.sessionId];
};

/** Total unread count for a specific host. */
export const selectUnreadCountByHost = (hostId: HostId): number => {
  const host = useMultiHostStore.getState().hosts[hostId];
  if (!host) return 0;
  let total = 0;
  for (const count of Object.values(host.unreadBySession)) {
    total += count;
  }
  return total;
};

/** Grand total unread across all hosts. */
export const selectTotalUnreadCount = (): number => {
  const hosts = useMultiHostStore.getState().hosts;
  let total = 0;
  for (const host of Object.values(hosts)) {
    for (const count of Object.values(host.unreadBySession)) {
      total += count;
    }
  }
  return total;
};

/**
 * Select hostIds that have at least one non-idle session.
 * Returns a new array only when the set of active hostIds changes.
 */
export const selectHostsWithActivity = (): HostId[] => {
  const hosts = useMultiHostStore.getState().hosts;
  const active: HostId[] = [];
  for (const [hostId, host] of Object.entries(hosts)) {
    for (const sessionStatus of Object.values(host.statuses)) {
      if (sessionStatus.status !== 'idle') {
        active.push(hostId as HostId);
        break;
      }
    }
  }
  return active;
};

// ---------------------------------------------------------------------------
// React hooks (thin wrappers around useStore with selectors)
// ---------------------------------------------------------------------------

/**
 * Subscribe to a specific host's runtime state. Re-renders only when this
 * host's reference changes.
 */
export const useHost = (hostId: HostId): HostRuntimeState | undefined =>
  useMultiHostStore((s) => s.hosts[hostId]);

/** Subscribe to the full hosts map. */
export const useHosts = (): Record<string, HostRuntimeState> =>
  useMultiHostStore((s) => s.hosts);

/** Subscribe to a host's sessions. */
export const useHostSessions = (hostId: HostId): Record<string, HostSessionSummary> =>
  useMultiHostStore((s) => s.hosts[hostId]?.sessions ?? EMPTY_SESSIONS);

/** Subscribe to a host's projects. */
export const useHostProjects = (hostId: HostId): HostRuntimeState['projects'] =>
  useMultiHostStore((s) => s.hosts[hostId]?.projects ?? EMPTY_PROJECTS);

/** Subscribe to a session by scoped ref. */
export const useSessionByRef = (ref: HostSessionRef): HostSessionSummary | undefined =>
  useMultiHostStore((s) => s.hosts[ref.hostId]?.sessions[ref.sessionId]);

/** Subscribe to session status by scoped ref. */
export const useSessionStatusByRef = (ref: HostSessionRef): HostSessionStatus | undefined =>
  useMultiHostStore((s) => s.hosts[ref.hostId]?.statuses[ref.sessionId]);

/** Subscribe to a host's total unread count. */
export const useUnreadCountByHost = (hostId: HostId): number =>
  useMultiHostStore((s) => {
    const host = s.hosts[hostId];
    if (!host) return 0;
    let total = 0;
    for (const count of Object.values(host.unreadBySession)) {
      total += count;
    }
    return total;
  });

/** Subscribe to the grand total unread count. */
export const useTotalUnreadCount = (): number =>
  useMultiHostStore((s) => {
    let total = 0;
    for (const host of Object.values(s.hosts)) {
      for (const count of Object.values(host.unreadBySession)) {
        total += count;
      }
    }
    return total;
  });

/** Subscribe to the list of hostIds with active (non-idle) sessions. */
export const useHostsWithActivity = (): HostId[] =>
  useMultiHostStore((s) => {
    const active: HostId[] = [];
    for (const [hostId, host] of Object.entries(s.hosts)) {
      for (const sessionStatus of Object.values(host.statuses)) {
        if (sessionStatus.status !== 'idle') {
          active.push(hostId as HostId);
          break;
        }
      }
    }
    return active;
  });
