import { normalizeDirectE2eeCandidate, type PairingDirectE2eeCandidate } from '@/lib/connectionPayload';

import {
  createRelayTunnelClient,
  TunnelChannelReadinessError,
  type RelayTunnelClient,
  type RelayTunnelClientOptions,
  type TunnelChannelReadinessContext,
} from './tunnel-client';
import { RelayCloseCode } from './protocol';

export type DirectE2eeRuntimeDescriptor = Omit<PairingDirectE2eeCandidate, 'type' | 'priority'>;

export const createDirectE2eeChannelReadiness = (runtimeBearerToken: string) => async ({ fetch }: TunnelChannelReadinessContext): Promise<void> => {
  let health: Response;
  try {
    health = await fetch('/health');
  } catch {
    throw new TunnelChannelReadinessError('direct E2EE health request failed', 'network', true);
  }
  if (health.status === 408 || health.status === 429 || health.status >= 500) {
    throw new TunnelChannelReadinessError(`direct E2EE health unavailable (${health.status})`, 'network', true);
  }
  if (health.status !== 200) {
    throw new TunnelChannelReadinessError(`direct E2EE health rejected (${health.status})`, 'protocol', false);
  }
  const healthBody: unknown = await health.json().catch(() => null);
  if (!healthBody || typeof healthBody !== 'object'
    || (healthBody as Record<string, unknown>).status !== 'ok'
    || typeof (healthBody as Record<string, unknown>).openchamberVersion !== 'string') {
    throw new TunnelChannelReadinessError('direct E2EE health response is not OpenChamber', 'protocol', false);
  }

  let session: Response;
  try {
    session = await fetch('/auth/session', { headers: { Authorization: `Bearer ${runtimeBearerToken}` } });
  } catch {
    throw new TunnelChannelReadinessError('direct E2EE session verification failed', 'network', true);
  }
  if (session.status === 401 || session.status === 403) {
    throw new TunnelChannelReadinessError('direct E2EE bearer token rejected', 'terminal', false);
  }
  if (session.status === 408 || session.status === 429 || session.status >= 500) {
    throw new TunnelChannelReadinessError(`direct E2EE session unavailable (${session.status})`, 'network', true);
  }
  if (session.status !== 200) {
    throw new TunnelChannelReadinessError(`direct E2EE session rejected (${session.status})`, 'protocol', false);
  }
  const sessionBody: unknown = await session.json().catch(() => null);
  if (!sessionBody || typeof sessionBody !== 'object' || (sessionBody as Record<string, unknown>).authenticated !== true) {
    throw new TunnelChannelReadinessError('direct E2EE session response is invalid', 'protocol', false);
  }
};

export const createDirectE2eeTunnelClient = (
  descriptor: DirectE2eeRuntimeDescriptor,
  runtimeBearerToken?: string | null,
  options: Omit<RelayTunnelClientOptions, 'hostEncPubJwk' | 'outerWebSocketUrl' | 'relayUrl' | 'serverId' | 'grant'> = {},
): RelayTunnelClient => {
  const normalized = normalizeDirectE2eeCandidate({ type: 'direct-e2ee', ...descriptor });
  if (!normalized) throw new Error('Invalid direct E2EE descriptor');
  return createRelayTunnelClient({
    ...options,
    outerWebSocketUrl: normalized.wssUrl,
    hostEncPubJwk: normalized.hostEncPubJwk,
    isTerminalCloseCode: options.isTerminalCloseCode ?? ((code) =>
      code === RelayCloseCode.RekeyMismatch || code === RelayCloseCode.ChannelFailure),
    isTerminalFailureClassification: options.isTerminalFailureClassification ?? ((classification) =>
      classification === 'crypto' || classification === 'protocol'),
    ...(runtimeBearerToken ? {
      channelReadiness: createDirectE2eeChannelReadiness(runtimeBearerToken),
    } : {}),
  });
};
