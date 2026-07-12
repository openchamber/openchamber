import { describe, expect, test } from 'bun:test';

import type { PairingConnectionPayload } from './connectionPayload';
import { firstHttpPairingCandidateUrl, PairingRedemptionError, redeemPairingCandidate } from './pairingCandidateRedemption';
import type { RelayTunnelClient, RelayTunnelStatus } from './relay/tunnel-client';

const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
const payload: PairingConnectionPayload = {
  v: 2,
  pairingId: 'pair',
  secret: 'one-time',
  candidates: [{ type: 'direct-e2ee', wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws', hostEncPubJwk: jwk }],
};

const healthBody = { status: 'ok', openchamberVersion: '1.15.0' };

const client = (requests: string[], failAt?: string, status: RelayTunnelStatus = { state: 'connected' }): RelayTunnelClient => ({
  async fetch(path, init) {
    requests.push(String(path));
    if (path === failAt) throw new Error('lost');
    if (path === '/health') return Response.json(healthBody);
    if (path === '/api/client-auth/pairing/redeem') {
      expect(String(init?.body)).toContain('one-time');
      return Response.json({ clientToken: 'oc_client_token' });
    }
    return Response.json({ authenticated: true });
  },
  openWebSocket: () => { throw new Error('unused'); },
  getStatus: () => status,
  subscribeStatus: () => () => {},
  close: () => {},
});

describe('pairing candidate redemption', () => {
  test('verifies encrypted health, redeems, then authorizes in order', async () => {
    const requests: string[] = [];
    const result = await redeemPairingCandidate(payload, {
      redeemBody: { clientKind: 'mobile' },
      createDirectE2eeClient: () => client(requests),
    });
    expect(requests).toEqual(['/health', '/api/client-auth/pairing/redeem', '/auth/session']);
    expect(result.token).toBe('oc_client_token');
  });

  test('retries a 503 on the same encrypted client and succeeds without recreating it', async () => {
    const requests: string[] = [];
    const recovering = client(requests);
    let healthCalls = 0;
    recovering.fetch = async (path, init) => {
      requests.push(String(path));
      if (path === '/health' && healthCalls++ === 0) return new Response(null, { status: 503 });
      if (path === '/health') return Response.json(healthBody);
      if (path === '/api/client-auth/pairing/redeem') return Response.json({ clientToken: 'token' });
      expect(init?.headers).toBeDefined();
      return Response.json({ authenticated: true });
    };
    let clientCreations = 0;
    const result = await redeemPairingCandidate(payload, {
      redeemBody: {},
      createDirectE2eeClient: () => { clientCreations += 1; return recovering; },
      healthRetryDelayMs: 0,
    });
    expect(result.token).toBe('token');
    expect(clientCreations).toBe(1);
    expect(requests).toEqual(['/health', '/health', '/api/client-auth/pairing/redeem', '/auth/session']);
  });

  test('falls through after repeated encrypted 503 responses without redeeming the first candidate', async () => {
    const firstRequests: string[] = [];
    const relayRequests: string[] = [];
    const unavailable = client(firstRequests);
    unavailable.fetch = async (path) => {
      firstRequests.push(String(path));
      return new Response(null, { status: 503 });
    };
    const multi: PairingConnectionPayload = {
      ...payload,
      candidates: [payload.candidates[0]!, { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server', hostEncPubJwk: jwk }],
    };
    const result = await redeemPairingCandidate(multi, {
      redeemBody: {},
      createDirectE2eeClient: () => unavailable,
      createRelayClient: () => client(relayRequests),
      healthRetryCount: 2,
      healthRetryDelayMs: 0,
    });
    expect(result.transport.kind).toBe('relay');
    expect(firstRequests).toEqual(['/health', '/health', '/health']);
    expect(relayRequests).toEqual(['/health', '/api/client-auth/pairing/redeem', '/auth/session']);
  });

  test('retries encrypted 429 and falls through on encrypted 404 without classifying either as security', async () => {
    for (const status of [429, 404]) {
      const requests: string[] = [];
      const unavailable = client(requests);
      unavailable.fetch = async (path) => {
        requests.push(String(path));
        return new Response(null, { status });
      };
      const multi: PairingConnectionPayload = {
        ...payload,
        candidates: [payload.candidates[0]!, { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server', hostEncPubJwk: jwk }],
      };
      const result = await redeemPairingCandidate(multi, {
        redeemBody: {},
        createDirectE2eeClient: () => unavailable,
        createRelayClient: () => client([]),
        healthRetryCount: 1,
        healthRetryDelayMs: 0,
      });
      expect(result.transport.kind).toBe('relay');
      expect(requests).toEqual(status === 429 ? ['/health', '/health'] : ['/health']);
    }
  });

  test('classifies a lost redemption response as ambiguous and never falls back', async () => {
    const requests: string[] = [];
    const error = await redeemPairingCandidate(payload, {
      redeemBody: {},
      createDirectE2eeClient: () => client(requests, '/api/client-auth/pairing/redeem'),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PairingRedemptionError);
    expect((error as PairingRedemptionError).classification).toBe('ambiguous');
    expect(requests).toEqual(['/health', '/api/client-auth/pairing/redeem']);
  });

  test('bounds an unreachable direct E2EE candidate and falls through to another encrypted candidate', async () => {
    const requests: string[] = [];
    const multi: PairingConnectionPayload = {
      ...payload,
      candidates: [
        payload.candidates[0]!,
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server', hostEncPubJwk: jwk },
      ],
    };
    const hanging = client(requests, undefined, { state: 'reconnecting', failureClassification: 'network' });
    hanging.fetch = async (_path, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const result = await redeemPairingCandidate(multi, {
      redeemBody: {},
      attemptTimeoutMs: 5,
      createDirectE2eeClient: () => hanging,
      createRelayClient: () => client(requests),
    });
    expect(result.transport.kind).toBe('relay');
  });

  test('treats pre-handshake protocol and crypto failures as terminal without fallback', async () => {
    for (const failureClassification of ['protocol', 'crypto'] as const) {
      let relayCreated = false;
      const multi: PairingConnectionPayload = {
        ...payload,
        candidates: [payload.candidates[0]!, { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server', hostEncPubJwk: jwk }],
      };
      const failing = client([], '/health', { state: 'error', failureClassification });
      const error = await redeemPairingCandidate(multi, {
        redeemBody: {},
        createDirectE2eeClient: () => failing,
        createRelayClient: () => {
          relayCreated = true;
          return client([]);
        },
      }).catch((value: unknown) => value);
      expect((error as PairingRedemptionError).classification).toBe('security');
      expect(relayCreated).toBe(false);
    }
  });

  test('classifies a redemption timeout as ambiguous and does not fall back', async () => {
    let relayCreated = false;
    const requests: string[] = [];
    const hanging = client(requests);
    hanging.fetch = async (path, init) => {
      requests.push(String(path));
      if (path === '/health') return Response.json(healthBody);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    const multi: PairingConnectionPayload = {
      ...payload,
      candidates: [payload.candidates[0]!, { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server', hostEncPubJwk: jwk }],
    };
    const error = await redeemPairingCandidate(multi, {
      redeemBody: {},
      attemptTimeoutMs: 5,
      createDirectE2eeClient: () => hanging,
      createRelayClient: () => {
        relayCreated = true;
        return client([]);
      },
    }).catch((value: unknown) => value);
    expect((error as PairingRedemptionError).classification).toBe('ambiguous');
    expect(relayCreated).toBe(false);
  });

  test('rejects HTTP 200 with a non-OpenChamber health body as a security failure', async () => {
    const wrongHealth = client([]);
    wrongHealth.fetch = async () => Response.json({ ok: true });
    const error = await redeemPairingCandidate(payload, {
      redeemBody: {},
      createDirectE2eeClient: () => wrongHealth,
    }).catch((value: unknown) => value);
    expect((error as PairingRedemptionError).classification).toBe('security');
  });

  test('selects only LAN or tunnel candidates as HTTP URLs', () => {
    expect(firstHttpPairingCandidateUrl(payload.candidates)).toBe(undefined);
    expect(firstHttpPairingCandidateUrl([
      payload.candidates[0]!,
      { type: 'lan', url: 'https://lan.example' },
    ])).toBe('https://lan.example');
  });
});
