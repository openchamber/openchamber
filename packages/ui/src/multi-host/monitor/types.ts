/**
 * Internal types for the multi-host monitor layer.
 *
 * These types are NOT exported from the public barrel; they are private to the
 * monitor module and used only by internal implementation files.
 */

import type { HostDescriptor, HostId, HostSessionStatus, HostSessionSummary } from '../types';

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/** HTTP request options for the monitor transport. */
export type MonitorFetchRequest = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
};

/** Opaque response from a monitor transport HTTP call. */
export type MonitorFetchResponse = {
  status: number;
  data: unknown;
  headers?: { get?: (name: string) => string | null } | Record<string, unknown>;
};

/**
 * Transport abstraction for HostMonitor. Each concrete transport (local,
 * direct, SSH) implements this interface; relay is injected by the
 * Integration PR.
 */
export interface HostMonitorTransport {
  /** Perform an HTTP request against the host. */
  request(fetchReq: MonitorFetchRequest): Promise<MonitorFetchResponse>;

  /**
   * Open a global event stream (SSE or WebSocket) and return an async
   * iterable of raw event frames. The caller owns the lifecycle and will
   * close via abort signal.
   */
  openEventStream(options: {
    signal: AbortSignal;
    lastEventId?: string;
  }): Promise<AsyncIterable<MonitorEventFrame>>;

  /** Release all resources held by this transport. */
  close(): void;
}

/** Raw event frame from a host's global event stream. */
export type MonitorEventFrame = {
  /** The directory the event belongs to (from SSE envelope or WS frame). */
  directory: string;
  /** The event payload — same shape as the SDK Event type. */
  payload: {
    id?: string;
    type: string;
    properties: Record<string, unknown>;
    [key: string]: unknown;
  };
};

// ---------------------------------------------------------------------------
// Normalized host events (internal event form)
// ---------------------------------------------------------------------------

export type NormalizedHostEvent =
  | {
      type: 'session-upsert';
      hostId: HostId;
      session: HostSessionSummary;
    }
  | {
      type: 'session-remove';
      hostId: HostId;
      sessionId: string;
    }
  | {
      type: 'session-status';
      hostId: HostId;
      sessionId: string;
      status: HostSessionStatus['status'];
    }
  | {
      type: 'host-refresh-required';
      hostId: HostId;
    };

// ---------------------------------------------------------------------------
// Host monitor internal state
// ---------------------------------------------------------------------------

export type HostMonitorState = 'idle' | 'connecting' | 'connected' | 'error';

/** Lifecycle generation — bumped on descriptor change to discard stale results. */
export type LifecycleGeneration = number & { readonly __brand: 'LifecycleGeneration' };

export const nextGeneration = (current: LifecycleGeneration): LifecycleGeneration =>
  (current + 1) as LifecycleGeneration;

// ---------------------------------------------------------------------------
// Scheduler abstraction (injectable for testing)
// ---------------------------------------------------------------------------

export interface MonitorScheduler {
  setTimeout(fn: () => void, ms: number): { cancel(): void };
  setInterval(fn: () => void, ms: number): { cancel(): void };
  now(): number;
}

// ---------------------------------------------------------------------------
// Reconnect policy
// ---------------------------------------------------------------------------

export type ReconnectAttempt = {
  delayMs: number;
  reason: string;
};

export interface ReconnectPolicy {
  /** Compute the delay before the next reconnect attempt. */
  nextDelay(attemptNumber: number, isPermanentError: boolean): ReconnectAttempt;
  /** Reset backoff after a successful connection. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Supervisor options
// ---------------------------------------------------------------------------

export type MultiHostSupervisorOptions = {
  /** Injectable scheduler for testing. Uses real timers by default. */
  scheduler?: MonitorScheduler;
  /** Injectable reconnect policy factory. Creates per-host policies. */
  reconnectPolicyFactory?: () => ReconnectPolicy;
  /** Injectable transport factory. Creates transports for each host. */
  transportFactory: TransportFactory;
  /** Reconciliation interval in ms. Default: 120_000 (2 min). */
  reconciliationIntervalMs?: number;
};

export type TransportFactory = (descriptor: HostDescriptor) => HostMonitorTransport;
