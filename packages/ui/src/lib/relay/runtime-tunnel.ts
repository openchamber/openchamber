// Module-level singleton holding the active relay tunnel client, if the runtime
// is in relay mode. Kept in its own module so runtime-switch, runtime-fetch,
// runtime-url, and the event pipeline can all read it without an import cycle
// (runtime-switch <-> runtime-url).

import { createRelayTunnelClient, type RelayTunnelClient } from './tunnel-client';
import { createDirectE2eeTunnelClient, type DirectE2eeRuntimeDescriptor } from './direct-e2ee-tunnel-client';

export interface RelayRuntimeDescriptor {
  type?: 'relay';
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
}

export type RuntimeTunnelDescriptor = RelayRuntimeDescriptor | ({ type: 'direct-e2ee' } & DirectE2eeRuntimeDescriptor);

let activeTunnel: RelayTunnelClient | null = null;
let activeDescriptor: RuntimeTunnelDescriptor | null = null;
let activeDirectToken: string | null = null;
let createHostedClient = createRelayTunnelClient;
let createDirectClient = createDirectE2eeTunnelClient;

const descriptorsEqual = (a: RuntimeTunnelDescriptor, b: RuntimeTunnelDescriptor): boolean => JSON.stringify(a) === JSON.stringify(b);

export const getActiveRelayTunnel = (): RelayTunnelClient | null => activeTunnel;

export const isRelayModeActive = (): boolean => activeTunnel !== null;

/**
 * Activates relay mode with the given descriptor, replacing any previous tunnel.
 * Reuses the existing client when the descriptor is unchanged so a redundant
 * runtime switch does not tear down a live tunnel.
 */
export const activateRuntimeTunnel = (descriptor: RuntimeTunnelDescriptor, clientToken?: string | null): RelayTunnelClient => {
  const directToken = descriptor.type === 'direct-e2ee' ? clientToken || null : null;
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)
    && (descriptor.type !== 'direct-e2ee' || activeDirectToken === directToken)) {
    return activeTunnel;
  }
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeDirectToken = directToken;
  activeTunnel = descriptor.type === 'direct-e2ee'
    ? createDirectClient(descriptor, directToken)
    : createHostedClient(descriptor);
  return activeTunnel;
};

/**
 * Adopts an ALREADY-OPEN tunnel client (e.g. the connect flow's probe tunnel)
 * as the active runtime tunnel, so the immediately following
 * `activateRuntimeTunnel` with an equal descriptor reuses it instead of paying a
 * second WebSocket connect + E2EE handshake. Replaces any previous tunnel.
 */
export const adoptRelayTunnel = (
  descriptor: RuntimeTunnelDescriptor,
  client: RelayTunnelClient,
  clientToken?: string | null,
): void => {
  if (activeTunnel === client) return;
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeDirectToken = descriptor.type === 'direct-e2ee' ? clientToken || null : null;
  activeTunnel = client;
};

export const setRuntimeTunnelClientFactoriesForTests = (factories: {
  createHosted?: typeof createRelayTunnelClient;
  createDirect?: typeof createDirectE2eeTunnelClient;
} | null): void => {
  deactivateRelayTunnel();
  createHostedClient = factories?.createHosted ?? createRelayTunnelClient;
  createDirectClient = factories?.createDirect ?? createDirectE2eeTunnelClient;
};

export const deactivateRelayTunnel = (): void => {
  activeTunnel?.close();
  activeTunnel = null;
  activeDescriptor = null;
  activeDirectToken = null;
};
