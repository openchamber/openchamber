import { createRelayTunnelClient, type RelayTunnelClient, type RelayTunnelStatus } from './tunnel-client';

export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
}

let activeTunnel: RelayTunnelClient | null = null;
let activeDescriptor: RelayRuntimeDescriptor | null = null;
const activeStatusListeners = new Set<(status: RelayTunnelStatus) => void>();
let detachActiveStatus: (() => void) | null = null;

const setActiveTunnel = (tunnel: RelayTunnelClient | null): void => {
  detachActiveStatus?.();
  detachActiveStatus = null;
  activeTunnel = tunnel;
  if (!tunnel) return;
  detachActiveStatus = tunnel.subscribeStatus((status) => {
    for (const listener of activeStatusListeners) listener(status);
  });
};

export const subscribeActiveRelayTunnelStatus = (listener: (status: RelayTunnelStatus) => void): (() => void) => {
  activeStatusListeners.add(listener);
  return () => {
    activeStatusListeners.delete(listener);
  };
};

const descriptorsEqual = (a: RelayRuntimeDescriptor, b: RelayRuntimeDescriptor): boolean =>
  a.relayUrl === b.relayUrl &&
  a.serverId === b.serverId &&
  a.grant === b.grant &&
  JSON.stringify(a.hostEncPubJwk) === JSON.stringify(b.hostEncPubJwk);

export const getActiveRelayTunnel = (): RelayTunnelClient | null => activeTunnel;
export const getActiveRelayDescriptor = (): Omit<RelayRuntimeDescriptor, 'grant'> | null => {
  if (!activeTunnel || !activeDescriptor) return null;
  return {
    relayUrl: activeDescriptor.relayUrl,
    serverId: activeDescriptor.serverId,
    hostEncPubJwk: { ...activeDescriptor.hostEncPubJwk },
  };
};

export const isRelayModeActive = (): boolean => activeTunnel !== null;

export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => {
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
    return activeTunnel;
  }
  activeTunnel?.close();
  activeDescriptor = descriptor;
  const tunnel = createRelayTunnelClient(descriptor);
  setActiveTunnel(tunnel);
  return tunnel;
};

export const adoptRelayTunnel = (descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  if (activeTunnel === client) {
    activeDescriptor = descriptor;
    return;
  }
  activeTunnel?.close();
  activeDescriptor = descriptor;
  setActiveTunnel(client);
};

export const deactivateRelayTunnel = (): void => {
  activeTunnel?.close();
  setActiveTunnel(null);
  activeDescriptor = null;
};
