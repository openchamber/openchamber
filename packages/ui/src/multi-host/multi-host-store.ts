/**
 * Multi-host Zustand store.
 *
 * Holds per-host state isolated by hostId. Sessions and statuses are nested
 * under their host — never flattened into a global sessionId-keyed Map.
 *
 * This store is a peer of the existing active-runtime store; it does NOT
 * modify or replace any existing session or sync store.
 */

import { create } from 'zustand';

import type {
  HostConnectionState,
  HostConnectionSummary,
  HostDescriptor,
  HostId,
  HostProjectSummary,
  HostSessionStatus,
  HostSessionSummary,
  HostSnapshot,
} from './types';

// ---------------------------------------------------------------------------
// Per-host state shape
// ---------------------------------------------------------------------------

/** State for a single host, isolated by hostId. */
export type HostRuntimeState = {
  descriptor: HostDescriptor;
  connection: HostConnectionSummary;
  projects: HostProjectSummary[];
  /** Sessions keyed by the host-local sessionId. */
  sessions: Record<string, HostSessionSummary>;
  /** Per-session status keyed by the host-local sessionId. */
  statuses: Record<string, HostSessionStatus>;
  /** Per-session unread count keyed by the host-local sessionId. */
  unreadBySession: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Store state + actions
// ---------------------------------------------------------------------------

export type MultiHostState = {
  /** All registered hosts, keyed by HostId. */
  hosts: Record<string, HostRuntimeState>;

  // -- Host lifecycle -------------------------------------------------------

  /** Register a new host. Idempotent: re-registering an existing hostId
   *  merges the descriptor and preserves runtime state. */
  registerHost: (descriptor: HostDescriptor) => void;

  /** Update the descriptor for an existing host. No-op if hostId unknown. */
  updateHostDescriptor: (hostId: HostId, patch: Partial<Omit<HostDescriptor, 'hostId'>>) => void;

  /** Remove a host and all its sessions, statuses, unread, and connection
   *  state. No-op if hostId unknown. */
  removeHost: (hostId: HostId) => void;

  // -- Connection -----------------------------------------------------------

  /** Set the connection state for a host. */
  setConnectionState: (hostId: HostId, state: HostConnectionState, error?: string) => void;

  // -- Projects -------------------------------------------------------------

  /** Replace the full project list for a host. */
  replaceProjects: (hostId: HostId, projects: HostProjectSummary[]) => void;

  // -- Sessions -------------------------------------------------------------

  /** Replace the full session list for a host. */
  replaceSessions: (hostId: HostId, sessions: HostSessionSummary[]) => void;

  /** Insert or update a single session. */
  upsertSession: (hostId: HostId, session: HostSessionSummary) => void;

  /** Remove a single session. */
  removeSession: (hostId: HostId, sessionId: string) => void;

  // -- Status ---------------------------------------------------------------

  /** Set session status (busy / retry / idle). Idle removes the entry. */
  setSessionStatus: (hostId: HostId, sessionId: string, status: HostSessionStatus['status']) => void;

  // -- Unread ---------------------------------------------------------------

  /** Mark a session as having unread activity. */
  markSessionUnread: (hostId: HostId, sessionId: string, count?: number) => void;

  /** Clear unread for a session. */
  clearSessionUnread: (hostId: HostId, sessionId: string) => void;

  // -- Bulk operations ------------------------------------------------------

  /**
   * Replace the entire snapshot for a host. Other hosts are untouched.
   *
   * Semantics after full server refresh:
   * - Sessions deleted by server are removed from the host
   * - Corresponding stale statuses are cleared
   * - Local unread counts are PRESERVED (server doesn't track unread)
   * - Descriptor is NOT accidentally overwritten (snapshot.descriptor is used)
   *
   * This function is idempotent: calling with the same snapshot produces no change.
   */
  replaceHostSnapshot: (hostId: HostId, snapshot: HostSnapshot) => void;

  /** Clear all runtime state for a host (sessions, statuses, unread,
   *  connection) while preserving the descriptor. */
  clearHostRuntimeState: (hostId: HostId) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hasKey = <K extends string>(record: Record<K, unknown>, key: K): boolean =>
  key in record;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useMultiHostStore = create<MultiHostState>()((set) => ({
  hosts: {},

  // -- Host lifecycle -------------------------------------------------------

  registerHost: (descriptor) => {
    set((state) => {
      const existing = state.hosts[descriptor.hostId];
      if (existing) {
        // Idempotent: merge descriptor, keep runtime state.
        const nextDescriptor =
          existing.descriptor === descriptor
            ? existing.descriptor
            : { ...existing.descriptor, ...descriptor, hostId: existing.descriptor.hostId };
        if (nextDescriptor === existing.descriptor) return state;
        return {
          hosts: {
            ...state.hosts,
            [descriptor.hostId]: { ...existing, descriptor: nextDescriptor },
          },
        };
      }
      return {
        hosts: {
          ...state.hosts,
          [descriptor.hostId]: {
            descriptor,
            connection: { state: 'disconnected' },
            projects: [],
            sessions: {},
            statuses: {},
            unreadBySession: {},
          },
        },
      };
    });
  },

  updateHostDescriptor: (hostId, patch) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      const nextDescriptor = { ...existing.descriptor, ...patch, hostId: existing.descriptor.hostId };
      if (nextDescriptor === existing.descriptor) return state;
      return {
        hosts: {
          ...state.hosts,
          [hostId]: { ...existing, descriptor: nextDescriptor },
        },
      };
    });
  },

  removeHost: (hostId) => {
    set((state) => {
      if (!hasKey(state.hosts, hostId)) return state;
      const next = { ...state.hosts };
      delete next[hostId];
      return { hosts: next };
    });
  },

  // -- Connection -----------------------------------------------------------

  setConnectionState: (hostId, connectionState, error) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      const prev = existing.connection;
      const nextConnection: HostConnectionSummary = {
        state: connectionState,
        ...(connectionState === 'connected' ? { connectedAt: new Date().toISOString() } : {}),
        ...(error !== undefined ? { error } : {}),
      };
      // Preserve connectedAt from previous connected state unless reconnecting.
      if (connectionState === 'connected' && prev.connectedAt && prev.state !== 'connected') {
        nextConnection.connectedAt = prev.connectedAt;
      }
      if (
        prev.state === nextConnection.state &&
        prev.connectedAt === nextConnection.connectedAt &&
        prev.error === nextConnection.error
      ) {
        return state;
      }
      return {
        hosts: {
          ...state.hosts,
          [hostId]: { ...existing, connection: nextConnection },
        },
      };
    });
  },

  // -- Projects -------------------------------------------------------------

  replaceProjects: (hostId, projects) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      if (existing.projects === projects) return state;
      return {
        hosts: {
          ...state.hosts,
          [hostId]: { ...existing, projects },
        },
      };
    });
  },

  // -- Sessions -------------------------------------------------------------

  replaceSessions: (hostId, sessionList) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      const nextSessions: Record<string, HostSessionSummary> = {};
      for (const s of sessionList) {
        nextSessions[s.id] = s;
      }
      // Skip update if session records are identical.
      const prev = existing.sessions;
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(nextSessions);
      if (prevKeys.length === nextKeys.length) {
        let identical = true;
        for (const key of nextKeys) {
          if (prev[key] !== nextSessions[key]) {
            identical = false;
            break;
          }
        }
        if (identical) return state;
      }
      return {
        hosts: {
          ...state.hosts,
          [hostId]: { ...existing, sessions: nextSessions },
        },
      };
    });
  },

  upsertSession: (hostId, session) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      if (existing.sessions[session.id] === session) return state;
      return {
        hosts: {
          ...state.hosts,
          [hostId]: {
            ...existing,
            sessions: { ...existing.sessions, [session.id]: session },
          },
        },
      };
    });
  },

  removeSession: (hostId, sessionId) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      if (!(sessionId in existing.sessions)) return state;

      const nextSessions = { ...existing.sessions };
      delete nextSessions[sessionId];
      const nextStatuses = { ...existing.statuses };
      delete nextStatuses[sessionId];
      const nextUnread = { ...existing.unreadBySession };
      delete nextUnread[sessionId];

      return {
        hosts: {
          ...state.hosts,
          [hostId]: {
            ...existing,
            sessions: nextSessions,
            statuses: nextStatuses,
            unreadBySession: nextUnread,
          },
        },
      };
    });
  },

  // -- Status ---------------------------------------------------------------

  setSessionStatus: (hostId, sessionId, status) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;

      if (status === 'idle') {
        if (!(sessionId in existing.statuses)) return state;
        const nextStatuses = { ...existing.statuses };
        delete nextStatuses[sessionId];
        return {
          hosts: {
            ...state.hosts,
            [hostId]: { ...existing, statuses: nextStatuses },
          },
        };
      }

      const prev = existing.statuses[sessionId];
      if (prev && prev.status === status) return state;
      return {
        hosts: {
          ...state.hosts,
          [hostId]: {
            ...existing,
            statuses: { ...existing.statuses, [sessionId]: { status } },
          },
        },
      };
    });
  },

  // -- Unread ---------------------------------------------------------------

  markSessionUnread: (hostId, sessionId, count = 1) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      const prev = existing.unreadBySession[sessionId] ?? 0;
      if (prev === count) return state;
      return {
        hosts: {
          ...state.hosts,
          [hostId]: {
            ...existing,
            unreadBySession: { ...existing.unreadBySession, [sessionId]: count },
          },
        },
      };
    });
  },

  clearSessionUnread: (hostId, sessionId) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      if (!(sessionId in existing.unreadBySession)) return state;
      const nextUnread = { ...existing.unreadBySession };
      delete nextUnread[sessionId];
      return {
        hosts: {
          ...state.hosts,
          [hostId]: { ...existing, unreadBySession: nextUnread },
        },
      };
    });
  },

  // -- Bulk operations ------------------------------------------------------

  replaceHostSnapshot: (hostId, snapshot) => {
    set((state) => {
      const existing = state.hosts[hostId];
      
      // Preserve local unread counts for sessions that exist in the snapshot
      // Remove unread counts for sessions that are NOT in the snapshot
      const preservedUnread = existing?.unreadBySession ?? {};
      const nextUnread: Record<string, number> = {};
      
      // Keep unread for sessions that exist in the snapshot
      for (const sessionId of Object.keys(snapshot.sessions)) {
        if (sessionId in preservedUnread) {
          nextUnread[sessionId] = preservedUnread[sessionId];
        }
      }
      
      // Add new unread counts from snapshot for sessions that don't exist locally
      if (snapshot.unreadBySession) {
        for (const [sessionId, count] of Object.entries(snapshot.unreadBySession)) {
          if (!(sessionId in nextUnread)) {
            nextUnread[sessionId] = count;
          }
        }
      }
      
      const next: HostRuntimeState = {
        descriptor: snapshot.descriptor,
        connection: snapshot.connection,
        projects: snapshot.projects,
        sessions: { ...snapshot.sessions },
        statuses: { ...snapshot.statuses },
        unreadBySession: nextUnread,
      };
      if (!existing) {
        return { hosts: { ...state.hosts, [hostId]: next } };
      }
      // Shallow comparison for idempotency.
      if (
        existing.descriptor === next.descriptor &&
        existing.connection === next.connection &&
        existing.projects === next.projects &&
        existing.sessions === next.sessions &&
        existing.statuses === next.statuses &&
        existing.unreadBySession === next.unreadBySession
      ) {
        return state;
      }
      return { hosts: { ...state.hosts, [hostId]: next } };
    });
  },

  clearHostRuntimeState: (hostId) => {
    set((state) => {
      const existing = state.hosts[hostId];
      if (!existing) return state;
      return {
        hosts: {
          ...state.hosts,
          [hostId]: {
            ...existing,
            connection: { state: 'disconnected' },
            projects: [],
            sessions: {},
            statuses: {},
            unreadBySession: {},
          },
        },
      };
    });
  },
}));
