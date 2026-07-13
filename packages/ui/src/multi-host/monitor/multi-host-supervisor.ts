/**
 * MultiHostSupervisor — orchestrates multiple HostMonitor instances.
 *
 * Each host gets an independent HostMonitor with its own transport,
 * event stream, reconnect policy, and reconciliation timer.
 * One host's failure never affects another.
 *
 * Non-React code can use the supervisor directly:
 *
 *   const supervisor = createMultiHostSupervisor({ transportFactory });
 *   supervisor.startHost(hostId, descriptor);
 *   supervisor.stopHost(hostId);
 *   supervisor.dispose();
 *
 * The Integration PR mounts the supervisor and wires it to the remote
 * instance registry.
 */

import type { HostDescriptor, HostId } from '../types';
import { useMultiHostStore } from '../multi-host-store';
import { HostMonitor } from './host-monitor';
import {
  type MonitorScheduler,
  type MultiHostSupervisorOptions,
} from './types';
import { createReconnectPolicy } from './reconnect-policy';

// ---------------------------------------------------------------------------
// Default scheduler (real timers)
// ---------------------------------------------------------------------------

const defaultScheduler: MonitorScheduler = {
  setTimeout: (fn, ms) => {
    const id = globalThis.setTimeout(fn, ms);
    return { cancel: () => globalThis.clearTimeout(id) };
  },
  setInterval: (fn, ms) => {
    const id = globalThis.setInterval(fn, ms);
    return { cancel: () => globalThis.clearInterval(id) };
  },
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export type MultiHostSupervisor = {
  /** Start monitoring a host. Idempotent: same hostId reuses existing monitor. */
  startHost(hostId: HostId, descriptor: HostDescriptor): void;
  /** Stop monitoring a host. Cleans up all resources for that host. */
  stopHost(hostId: HostId): void;
  /** Restart a host with an updated descriptor. */
  restartHost(hostId: HostId, descriptor?: HostDescriptor): void;
  /** Force an immediate refresh of a host. */
  refreshHost(hostId: HostId): void;
  /** Start monitoring all given hosts. */
  startAll(hosts: Map<HostId, HostDescriptor>): void;
  /** Stop all monitored hosts. */
  stopAll(): void;
  /** Check if a host is being monitored. */
  hasHost(hostId: HostId): boolean;
  /** Dispose the supervisor and prevent further store writes. */
  dispose(): void;
};

export function createMultiHostSupervisor(
  options: MultiHostSupervisorOptions,
): MultiHostSupervisor {
  const {
    scheduler = defaultScheduler,
    transportFactory,
    reconciliationIntervalMs = 120_000,
  } = options;

  const monitors = new Map<HostId, HostMonitor>();
  let disposed = false;

  const getOrCreateMonitor = (
    hostId: HostId,
    descriptor: HostDescriptor,
  ): HostMonitor => {
    const existing = monitors.get(hostId);
    if (existing) return existing;

    const reconnectPolicy = options.reconnectPolicyFactory?.() ?? createReconnectPolicy();
    const transport = transportFactory(descriptor);

    const monitor = new HostMonitor({
      hostId,
      descriptor,
      transport,
      scheduler,
      reconnectPolicy,
      reconciliationIntervalMs,
    });

    monitors.set(hostId, monitor);
    return monitor;
  };

  const startHost = (hostId: HostId, descriptor: HostDescriptor): void => {
    if (disposed) return;

    // Register in store
    useMultiHostStore.getState().registerHost(descriptor);

    const monitor = getOrCreateMonitor(hostId, descriptor);
    monitor.start();
  };

  const stopHost = (hostId: HostId): void => {
    const monitor = monitors.get(hostId);
    if (monitor) {
      monitor.stop();
    }
  };

  const restartHost = (hostId: HostId, descriptor?: HostDescriptor): void => {
    const monitor = monitors.get(hostId);
    if (!monitor) {
      if (descriptor) {
        startHost(hostId, descriptor);
      }
      return;
    }

    if (descriptor) {
      monitor.updateDescriptor(descriptor);
    }
    monitor.stop();
    monitor.start();
  };

  const refreshHost = (hostId: HostId): void => {
    const monitor = monitors.get(hostId);
    if (monitor) {
      monitor.refresh();
    }
  };

  const startAll = (hosts: Map<HostId, HostDescriptor>): void => {
    for (const [hostId, descriptor] of hosts) {
      startHost(hostId, descriptor);
    }
  };

  const stopAll = (): void => {
    for (const monitor of monitors.values()) {
      monitor.stop();
      monitor.dispose();
    }
    monitors.clear();
  };

  const hasHost = (hostId: HostId): boolean => monitors.has(hostId);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopAll();
  };

  return {
    startHost,
    stopHost,
    restartHost,
    refreshHost,
    startAll,
    stopAll,
    hasHost,
    dispose,
  };
}
