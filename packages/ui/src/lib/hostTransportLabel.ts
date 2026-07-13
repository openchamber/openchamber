/**
 * Pure host transport type to locale key mapping.
 * Resolves a host's transport configuration to a distinct managed-direct-E2EE or Relay label key.
 *
 * Contract:
 * - Direct-E2EE-only hosts resolve to managed direct-E2EE label
 * - Relay-only hosts resolve to Relay label
 * - Direct-only hosts return null (no label needed)
 * - Malformed hosts with both transports: defensive behavior prefers direct-E2EE, never displays Relay
 */

import type { DesktopHost } from './desktopHosts';

export type HostTransportLabelKey =
  | 'settings.remoteInstances.clientAuth.state.viaManagedDirectE2ee'
  | 'settings.remoteInstances.clientAuth.state.viaRelay'
  | null;

export const hostTransportLabelKey = (host: DesktopHost): HostTransportLabelKey => {
  if (host.directE2ee) {
    return 'settings.remoteInstances.clientAuth.state.viaManagedDirectE2ee';
  }

  if (host.relay) {
    return 'settings.remoteInstances.clientAuth.state.viaRelay';
  }

  return null;
};
