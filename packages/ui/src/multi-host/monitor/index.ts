/**
 * Multi-host monitor — public API barrel.
 *
 * Import from '@/multi-host/monitor' to use the supervisor and transport
 * factory. Do not import internal files directly.
 */

export { createMultiHostSupervisor } from './multi-host-supervisor';
export type { MultiHostSupervisor } from './multi-host-supervisor';

export type {
  HostMonitorTransport,
  HostMonitorState,
  MonitorFetchRequest,
  MonitorFetchResponse,
  MonitorEventFrame,
  NormalizedHostEvent,
  MonitorScheduler,
  ReconnectPolicy,
  MultiHostSupervisorOptions,
  TransportFactory,
} from './types';

export { normalizeHostEvent } from './event-normalizer';
export { reconcileHost } from './reconciliation';
export type { ReconcileResult } from './reconciliation';
