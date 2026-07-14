// Module-level singleton holding the active relay tunnel client, if the runtime
// is in relay mode. Kept in its own module so runtime-switch, runtime-fetch,
// runtime-url, and the event pipeline can all read it without an import cycle
// (runtime-switch <-> runtime-url).

import { createRelayTunnelClient, type RelayTunnelClient } from './tunnel-client';

export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
}

let activeTunnel: RelayTunnelClient | null = null;
let activeDescriptor: RelayRuntimeDescriptor | null = null;

const descriptorsEqual = (a: RelayRuntimeDescriptor, b: RelayRuntimeDescriptor): boolean =>
  a.relayUrl === b.relayUrl &&
  a.serverId === b.serverId &&
  a.grant === b.grant &&
  JSON.stringify(a.hostEncPubJwk) === JSON.stringify(b.hostEncPubJwk);

export const getActiveRelayTunnel = (): RelayTunnelClient | null => activeTunnel;

export const isRelayModeActive = (): boolean => activeTunnel !== null;

/**
 * Activates relay mode with the given descriptor, replacing any previous tunnel.
 * Reuses the existing client when the descriptor is unchanged so a redundant
 * runtime switch does not tear down a live tunnel.
 */
export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => {
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
    return activeTunnel;
  }
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeTunnel = createRelayTunnelClient(descriptor);
  return activeTunnel;
};

/**
 * Adopts an ALREADY-OPEN tunnel client (e.g. the connect flow's probe tunnel)
 * as the active runtime tunnel, so the immediately following
 * `activateRelayTunnel` with an equal descriptor reuses it instead of paying a
 * second WebSocket connect + E2EE handshake. Replaces any previous tunnel.
 */
export const adoptRelayTunnel = (descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  if (activeTunnel === client) return;
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeTunnel = client;
};

export const deactivateRelayTunnel = (): void => {
  activeTunnel?.close();
  activeTunnel = null;
  activeDescriptor = null;
};
