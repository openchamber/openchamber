import type { PairingConnectionPayload, PairingEndpointCandidate } from './connectionPayload';
import { createDirectE2eeTunnelClient } from './relay/direct-e2ee-tunnel-client';
import { createRelayTunnelClient, type RelayTunnelClient, type RelayTunnelStatus } from './relay/tunnel-client';

export type PairingRedeemedTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relayUrl: string; serverId: string; hostEncPubJwk: JsonWebKey }
  | { kind: 'direct-e2ee'; wssUrl: string; hostEncPubJwk: JsonWebKey };

export class PairingRedemptionError extends Error {
  constructor(
    public readonly classification: 'unreachable' | 'security' | 'credential' | 'ambiguous' | 'authorization',
    message: string,
  ) {
    super(message);
    this.name = 'PairingRedemptionError';
  }
}

export interface PairingRedemptionOptions {
  redeemBody: Record<string, unknown>;
  directFetch?: typeof fetch;
  createRelayClient?: (candidate: Extract<PairingEndpointCandidate, { type: 'relay' }>) => RelayTunnelClient;
  createDirectE2eeClient?: (candidate: Extract<PairingEndpointCandidate, { type: 'direct-e2ee' }>) => RelayTunnelClient;
  attemptTimeoutMs?: number;
  healthRetryCount?: number;
  healthRetryDelayMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}

const candidateRank = (candidate: PairingEndpointCandidate): number => {
  if (candidate.type === 'lan' || candidate.type === 'tunnel') return candidate.url.startsWith('https://') ? 0 : 1;
  if (candidate.type === 'direct-e2ee') return 2;
  return 3;
};

const orderPairingCandidates = (candidates: PairingEndpointCandidate[]): PairingEndpointCandidate[] =>
  [...candidates].sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100) || candidateRank(left) - candidateRank(right));

const validHealthBody = async (response: Response): Promise<boolean> => {
  const body = await response.clone().json().catch(() => null) as { status?: unknown; openchamberVersion?: unknown } | null;
  return body?.status === 'ok' && typeof body.openchamberVersion === 'string' && body.openchamberVersion.length > 0;
};

const retryableHealthStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

const securityFailure = (status: RelayTunnelStatus | undefined): boolean =>
  status?.failureClassification === 'crypto'
  || status?.failureClassification === 'protocol'
  || status?.failureClassification === 'terminal';

class PairingAttemptTimeoutError extends Error {
  constructor() {
    super('Pairing candidate attempt timed out');
    this.name = 'PairingAttemptTimeoutError';
  }
}

const requestWithTimeout = async (
  request: (path: string, init?: RequestInit) => Promise<Response>,
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init?.signal;
  const onExternalAbort = (): void => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    return await Promise.race([
      request(path, { ...init, signal: controller.signal }),
      new Promise<Response>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new PairingAttemptTimeoutError()), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
};

export const redeemPairingCandidate = async (
  payload: PairingConnectionPayload,
  options: PairingRedemptionOptions,
): Promise<{ token: string; transport: PairingRedeemedTransport }> => {
  const directFetch = options.directFetch ?? fetch;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 10_000;
  const healthRetryCount = Math.max(0, options.healthRetryCount ?? 2);
  const healthRetryDelayMs = Math.max(0, options.healthRetryDelayMs ?? 100);
  const delay = options.delay ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (const candidate of orderPairingCandidates(payload.candidates)) {
    let tunnel: RelayTunnelClient | null = null;
    let request: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
    try {
      if (candidate.type === 'relay') {
        tunnel = options.createRelayClient?.(candidate) ?? createRelayTunnelClient(candidate);
        request = tunnel.fetch;
      } else if (candidate.type === 'direct-e2ee') {
        tunnel = options.createDirectE2eeClient?.(candidate) ?? createDirectE2eeTunnelClient(candidate);
        request = tunnel.fetch;
      } else {
        request = (path, init) => directFetch(`${candidate.url}${path}`, init);
      }

      let health: Response | null = null;
      for (let healthAttempt = 0; healthAttempt <= healthRetryCount; healthAttempt += 1) {
        try {
          health = await requestWithTimeout(request, '/health', undefined, attemptTimeoutMs);
        } catch (error) {
          if (securityFailure(tunnel?.getStatus())) {
            throw new PairingRedemptionError('security', error instanceof Error ? error.message : 'E2EE verification failed');
          }
          health = null;
          break;
        }
        if (!retryableHealthStatus(health.status) || healthAttempt === healthRetryCount) break;
        await delay(healthRetryDelayMs);
      }
      if (!health || health.status !== 200) continue;
      if (!(await validHealthBody(health))) {
        if (candidate.type === 'direct-e2ee' || candidate.type === 'relay') {
          throw new PairingRedemptionError('security', 'Encrypted host health verification failed');
        }
        continue;
      }

      let redeemResponse: Response;
      try {
        redeemResponse = await requestWithTimeout(request, '/api/client-auth/pairing/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ pairingId: payload.pairingId, secret: payload.secret, ...options.redeemBody }),
        }, attemptTimeoutMs);
      } catch (error) {
        if (securityFailure(tunnel?.getStatus())) {
          throw new PairingRedemptionError('security', error instanceof Error ? error.message : 'E2EE verification failed');
        }
        throw new PairingRedemptionError('ambiguous', error instanceof Error ? error.message : 'Pairing response was lost');
      }
      if (!redeemResponse.ok) throw new PairingRedemptionError('credential', 'Pairing secret was rejected');
      const body = await redeemResponse.json().catch(() => null) as { clientToken?: unknown } | null;
      const token = typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
      if (!token) throw new PairingRedemptionError('credential', 'Pairing response did not contain a client token');

      let session: Response;
      try {
        session = await requestWithTimeout(request, '/auth/session', { headers: { Authorization: `Bearer ${token}` } }, attemptTimeoutMs);
      } catch (error) {
        if (securityFailure(tunnel?.getStatus())) {
          throw new PairingRedemptionError('security', error instanceof Error ? error.message : 'E2EE verification failed');
        }
        throw new PairingRedemptionError('authorization', error instanceof Error ? error.message : 'Client token authorization timed out');
      }
      const sessionBody = await session.clone().json().catch(() => null) as { authenticated?: unknown } | null;
      if (!session.ok || sessionBody?.authenticated !== true) {
        throw new PairingRedemptionError('authorization', 'Client token authorization failed');
      }
      const transport: PairingRedeemedTransport = candidate.type === 'relay'
        ? { kind: 'relay', relayUrl: candidate.relayUrl, serverId: candidate.serverId, hostEncPubJwk: candidate.hostEncPubJwk }
        : candidate.type === 'direct-e2ee'
          ? { kind: 'direct-e2ee', wssUrl: candidate.wssUrl, hostEncPubJwk: candidate.hostEncPubJwk }
          : { kind: 'direct', url: candidate.url };
      return { token, transport };
    } catch (error) {
      if (error instanceof PairingRedemptionError && error.classification !== 'unreachable') throw error;
      if ((candidate.type === 'direct-e2ee' || candidate.type === 'relay') && securityFailure(tunnel?.getStatus())) {
        throw new PairingRedemptionError('security', error instanceof Error ? error.message : 'Direct E2EE verification failed');
      }
    } finally {
      tunnel?.close();
    }
  }
  throw new PairingRedemptionError('unreachable', 'No pairing candidate was reachable');
};
