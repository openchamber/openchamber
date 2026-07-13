/**
 * HostMonitor — manages a single host's connection lifecycle, event
 * subscription, reconciliation, and reconnect logic.
 *
 * Each HostMonitor is fully independent: its failure, reconnect, or refresh
 * never affects other monitors.
 *
 * Lifecycle:
 * 1. start() → connects transport, subscribes to event stream, starts reconciliation
 * 2. Events arrive → normalized → written to store
 * 3. On disconnect → reconnect with exponential backoff
 * 4. On reconnect → full reconciliation refresh
 * 5. stop() → cleans up everything
 * 6. dispose() → prevents further store writes
 */

import type {
  HostDescriptor,
  HostId,
  HostSnapshot,
} from '../types';
import { useMultiHostStore } from '../multi-host-store';
import {
  type HostMonitorTransport,
  type HostMonitorState,
  type LifecycleGeneration,
  type MonitorScheduler,
  type MonitorEventFrame,
  type NormalizedHostEvent,
  type ReconnectPolicy,
  nextGeneration,
} from './types';
import { normalizeHostEvent } from './event-normalizer';
import { reconcileHost } from './reconciliation';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type InternalState = {
  state: HostMonitorState;
  generation: LifecycleGeneration;
  eventAbort: AbortController | null;
  reconciliationTimer: { cancel(): void } | null;
  reconnectTimer: { cancel(): void } | null;
  refreshInFlight: Promise<HostSnapshot> | null;
  lastSuccessAt: number;
  disposed: boolean;
};

// ---------------------------------------------------------------------------
// HostMonitor
// ---------------------------------------------------------------------------

export class HostMonitor {
  private hostId: HostId;
  private descriptor: HostDescriptor;
  private transport: HostMonitorTransport;
  private scheduler: MonitorScheduler;
  private reconnectPolicy: ReconnectPolicy;
  private reconciliationIntervalMs: number;

  private state: InternalState = {
    state: 'idle',
    generation: 0 as LifecycleGeneration,
    eventAbort: null,
    reconciliationTimer: null,
    reconnectTimer: null,
    refreshInFlight: null,
    lastSuccessAt: 0,
    disposed: false,
  };

  private consecutiveFailures = 0;

  constructor(options: {
    hostId: HostId;
    descriptor: HostDescriptor;
    transport: HostMonitorTransport;
    scheduler: MonitorScheduler;
    reconnectPolicy: ReconnectPolicy;
    reconciliationIntervalMs: number;
  }) {
    this.hostId = options.hostId;
    this.descriptor = options.descriptor;
    this.transport = options.transport;
    this.scheduler = options.scheduler;
    this.reconnectPolicy = options.reconnectPolicy;
    this.reconciliationIntervalMs = options.reconciliationIntervalMs;
  }

  // -- Public API -------------------------------------------------------------

  /** Start monitoring this host. Idempotent. */
  start(): void {
    if (this.state.disposed) return;
    if (this.state.state === 'connecting' || this.state.state === 'connected') return;

    this.connect();
  }

  /** Stop monitoring this host. Cleans up all resources. */
  stop(): void {
    this.clearAllTimers();
    this.closeEventStream();
    this.state.state = 'idle';
    this.state.refreshInFlight = null;
    this.consecutiveFailures = 0;
    this.reconnectPolicy.reset();

    // Update store
    if (!this.state.disposed) {
      useMultiHostStore.getState().setConnectionState(this.hostId, 'disconnected');
    }
  }

  /** Update the descriptor. If transport changed, restart the connection. */
  updateDescriptor(descriptor: HostDescriptor): void {
    const prevTransport = JSON.stringify(this.descriptor.transport);
    const nextTransport = JSON.stringify(descriptor.transport);
    this.descriptor = descriptor;

    if (prevTransport !== nextTransport) {
      // Transport changed — restart with new generation
      this.stop();
      this.state.generation = nextGeneration(this.state.generation);
      this.start();
    }
    // If only label changed, no-op for connection
  }

  /** Force an immediate reconciliation refresh. */
  refresh(): void {
    if (this.state.disposed) return;
    this.runRefresh(this.state.generation);
  }

  /** Get the current connection state. */
  getConnectionState(): HostMonitorState {
    return this.state.state;
  }

  /** Dispose and prevent further store writes. */
  dispose(): void {
    this.stop();
    this.state.disposed = true;
  }

  // -- Connection logic -------------------------------------------------------

  private connect(): void {
    if (this.state.disposed) return;

    this.state.state = 'connecting';
    useMultiHostStore.getState().setConnectionState(this.hostId, 'connecting');

    const generation = this.state.generation;

    // Abort any previous event stream
    this.closeEventStream();

    // Create new abort controller for this connection attempt
    const abort = new AbortController();
    this.state.eventAbort = abort;

    // Start event stream and reconciliation
    this.runEventStream(generation, abort.signal);
    this.startReconciliationTimer(generation);
  }

  private async runEventStream(
    generation: LifecycleGeneration,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.state.disposed) return;

    try {
      const stream = await this.transport.openEventStream({ signal });

      // Check generation is still current
      if (generation !== this.state.generation) return;

      this.state.state = 'connected';
      this.consecutiveFailures = 0;
      this.reconnectPolicy.reset();
      this.state.lastSuccessAt = this.scheduler.now();
      useMultiHostStore.getState().setConnectionState(this.hostId, 'connected');

      // Run reconciliation immediately on successful connection
      this.runRefresh(generation);

      // Consume events
      for await (const frame of stream) {
        if (signal.aborted || generation !== this.state.generation) break;
        this.handleEvent(frame);
      }
    } catch (error) {
      if (signal.aborted || generation !== this.state.generation) return;
      if (this.state.disposed) return;

      this.state.state = 'error';
      const errorMessage = error instanceof Error ? error.message : 'Event stream failed';
      useMultiHostStore.getState().setConnectionState(this.hostId, 'error', errorMessage);

      // Schedule reconnect
      this.scheduleReconnect(generation);
    }
  }

  private handleEvent(frame: MonitorEventFrame): void {
    if (this.state.disposed) return;

    const events = normalizeHostEvent(this.hostId, frame);
    const store = useMultiHostStore.getState();

    for (const event of events) {
      this.applyEvent(store, event);
    }
  }

  private applyEvent(
    store: ReturnType<typeof useMultiHostStore.getState>,
    event: NormalizedHostEvent,
  ): void {
    switch (event.type) {
      case 'session-upsert':
        store.upsertSession(event.hostId, event.session);
        break;
      case 'session-remove':
        store.removeSession(event.hostId, event.sessionId);
        break;
      case 'session-status':
        store.setSessionStatus(event.hostId, event.sessionId, event.status);
        break;
      case 'host-refresh-required':
        this.runRefresh(this.state.generation);
        break;
    }
  }

  // -- Reconnect logic --------------------------------------------------------

  private scheduleReconnect(generation: LifecycleGeneration): void {
    if (this.state.disposed) return;
    if (generation !== this.state.generation) return;

    this.clearReconnectTimer();

    this.consecutiveFailures += 1;
    const { delayMs } = this.reconnectPolicy.nextDelay(this.consecutiveFailures, false);

    this.state.reconnectTimer = this.scheduler.setTimeout(() => {
      if (generation !== this.state.generation || this.state.disposed) return;
      this.state.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  // -- Reconciliation ---------------------------------------------------------

  private startReconciliationTimer(generation: LifecycleGeneration): void {
    this.clearReconciliationTimer();

    this.state.reconciliationTimer = this.scheduler.setInterval(() => {
      if (generation !== this.state.generation || this.state.disposed) return;
      this.runRefresh(generation);
    }, this.reconciliationIntervalMs);
  }

  private runRefresh(
    generation: LifecycleGeneration,
  ): void {
    if (this.state.disposed) return;
    if (generation !== this.state.generation) return;

    // Deduplicate concurrent refreshes
    if (this.state.refreshInFlight) return;

    const promise = this.doRefresh(generation);
    this.state.refreshInFlight = promise;

    promise.finally(() => {
      if (this.state.refreshInFlight === promise) {
        this.state.refreshInFlight = null;
      }
    });
  }

  private async doRefresh(generation: LifecycleGeneration): Promise<HostSnapshot> {
    // Capture the abort signal for this generation
    const signal = this.state.eventAbort?.signal;

    const existingSnapshot: HostSnapshot | undefined = (() => {
      const hostState = useMultiHostStore.getState().hosts[this.hostId];
      if (!hostState) return undefined;
      return {
        descriptor: hostState.descriptor,
        connection: hostState.connection,
        projects: hostState.projects,
        sessions: hostState.sessions,
        statuses: hostState.statuses,
        unreadBySession: hostState.unreadBySession,
      };
    })();

    const result = await reconcileHost(
      this.hostId,
      this.descriptor,
      this.transport,
      existingSnapshot,
      signal,
    );

    // Check generation is still current
    if (generation !== this.state.generation || this.state.disposed) {
      return result.snapshot;
    }

    if (result.ok) {
      // Use replaceHostSnapshot which preserves unread for existing sessions
      // and removes sessions/statuses that server no longer reports
      useMultiHostStore.getState().replaceHostSnapshot(this.hostId, result.snapshot);
    }

    return result.snapshot;
  }

  // -- Cleanup ----------------------------------------------------------------

  private closeEventStream(): void {
    if (this.state.eventAbort) {
      this.state.eventAbort.abort();
      this.state.eventAbort = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.state.reconnectTimer) {
      this.state.reconnectTimer.cancel();
      this.state.reconnectTimer = null;
    }
  }

  private clearReconciliationTimer(): void {
    if (this.state.reconciliationTimer) {
      this.state.reconciliationTimer.cancel();
      this.state.reconciliationTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearReconnectTimer();
    this.clearReconciliationTimer();
    this.closeEventStream();
  }
}
