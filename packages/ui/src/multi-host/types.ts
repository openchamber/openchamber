/**
 * Multi-host domain types for monitoring multiple OpenChamber servers
 * concurrently. This module is a standalone, lightweight, UI-free, network-free
 * domain layer — no transport, event subscription, or runtime switching logic.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Stable identifier for a remote (or local) OpenChamber host. */
export type HostId = string & { readonly __brand: 'HostId' };

/** Branded session identifier scoped to a single host. */
export type ScopedSessionId = string & { readonly __brand: 'ScopedSessionId' };

// ---------------------------------------------------------------------------
// Transport descriptors (discriminated union for type safety)
// ---------------------------------------------------------------------------

/** How a host is reached. Discriminated union ensures type-safe transport configuration. */
export type HostTransportKind = 'local' | 'direct' | 'ssh' | 'relay';

/** Base transport configuration shared by all transport types. */
type HostTransportBase = {
  /** Extra request headers sent with API calls to this host. */
  requestHeaders?: Record<string, string>;
};

/** Local transport - connects to a local OpenChamber instance. */
type HostTransportLocal = HostTransportBase & {
  kind: 'local';
  /** Base URL for local connection. */
  apiUrl?: string;
};

/** Direct transport - connects directly to a remote instance via URL. */
type HostTransportDirect = HostTransportBase & {
  kind: 'direct';
  /** Base URL for direct connection. */
  apiUrl: string;
};

/** SSH transport - connects via SSH tunnel. */
type HostTransportSsh = HostTransportBase & {
  kind: 'ssh';
  /** SSH forwarded endpoint (host:port). */
  sshEndpoint: string;
};

/** Relay transport - connects via private relay. */
type HostTransportRelay = HostTransportBase & {
  kind: 'relay';
  /** Relay server id. */
  relayServerId: string;
};

/** Discriminated union of all transport types. */
export type HostTransport = HostTransportLocal | HostTransportDirect | HostTransportSsh | HostTransportRelay;

export type HostDescriptor = {
  /** Application-assigned stable id. */
  readonly hostId: HostId;
  /** Human-readable display name. */
  label: string;
  /** How the client reaches this host. Discriminated union ensures type safety. */
  transport: HostTransport;
};

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type HostConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type HostConnectionSummary = {
  state: HostConnectionState;
  /** ISO-8601 timestamp of last successful connection, if any. */
  connectedAt?: string;
  /** Human-readable error message when state is 'error'. */
  error?: string;
};

// ---------------------------------------------------------------------------
// Project / session summaries
// ---------------------------------------------------------------------------

/** Lightweight project identity reported by a host. */
export type HostProjectSummary = {
  readonly id: string;
  name?: string;
  directory?: string;
};

/**
 * A session reference that is always scoped to a specific host.
 * The combination (hostId, sessionId) is unique; sessionId alone is NOT
 * globally unique across hosts.
 *
 * This ref must contain enough information for the activation controller to:
 * 1. Switch to the correct host
 * 2. Open the corresponding project/worktree
 * 3. Select the session
 */
export type HostSessionRef = {
  readonly hostId: HostId;
  readonly sessionId: string;
  /** Directory path for the project/worktree. Required for activation controller. */
  readonly directory: string;
  /** Project identifier. Required for activation controller. */
  readonly projectId: string;
};

/** Summary of a session as reported by its host. */
export type HostSessionSummary = {
  readonly id: string;
  title?: string;
  directory?: string;
  projectId?: string;
  createdAt?: number;
  updatedAt?: number;
};

// ---------------------------------------------------------------------------
// Session status
// ---------------------------------------------------------------------------

/** Per-session busy / retry status reported by a host. */
export type HostSessionStatus = {
  status: 'idle' | 'busy' | 'retry';
};

// ---------------------------------------------------------------------------
// Host snapshot (full state for a single host)
// ---------------------------------------------------------------------------

/** Complete local state for a single host, used by replaceHostSnapshot. */
export type HostSnapshot = {
  descriptor: HostDescriptor;
  connection: HostConnectionSummary;
  projects: HostProjectSummary[];
  sessions: Record<string, HostSessionSummary>;
  statuses: Record<string, HostSessionStatus>;
  unreadBySession: Record<string, number>;
};
