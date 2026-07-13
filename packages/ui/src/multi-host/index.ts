/**
 * Multi-host domain layer — public API.
 *
 * Import from '@/multi-host' (or '@openchamber/ui/multi-host') to consume
 * types, store actions, selectors, and hooks. Do not import internal files
 * directly; this barrel ensures a stable public surface.
 */

// -- Types ------------------------------------------------------------------
export type {
  HostConnectionState,
  HostConnectionSummary,
  HostDescriptor,
  HostId,
  HostProjectSummary,
  HostSessionRef,
  HostSessionStatus,
  HostSessionSummary,
  HostSnapshot,
  HostTransport,
  HostTransportKind,
  ScopedSessionId,
} from './types';

// -- Host registry ----------------------------------------------------------
export { generateHostId, hostIdFromExistingId, normalizeDescriptor, mergeDescriptor } from './host-registry';

// -- Store ------------------------------------------------------------------
export { useMultiHostStore } from './multi-host-store';
/**
 * HostRuntimeState is the internal state shape for a single host.
 * Use this type for reading state only; use store actions for mutations.
 */
export type { HostRuntimeState, MultiHostState } from './multi-host-store';

// -- Selectors & hooks ------------------------------------------------------
export {
  selectHost,
  selectHosts,
  selectHostSessions,
  selectHostProjects,
  selectSessionByRef,
  selectSessionStatusByRef,
  selectUnreadCountByHost,
  selectTotalUnreadCount,
  selectHostsWithActivity,
  useHost,
  useHosts,
  useHostSessions,
  useHostProjects,
  useSessionByRef,
  useSessionStatusByRef,
  useUnreadCountByHost,
  useTotalUnreadCount,
  useHostsWithActivity,
} from './selectors';
