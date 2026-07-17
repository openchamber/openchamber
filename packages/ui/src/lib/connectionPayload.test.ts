import { describe, expect, test } from 'bun:test';

import {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
} from './connectionPayload';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as const;

describe('connection payload helpers', () => {
  test('round-trips v2 pairing payloads with direct candidates', () => {
    const payload = buildPairingConnectionPayload({
      pairingId: 'pair_123',
      secret: 'one-time-secret',
      label: 'Desktop',
      fingerprint: 'ABCD-1234',
      expiresAt: '2099-01-01T00:00:00.000Z',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096/', priority: 20 },
        { type: 'tunnel', url: 'https://runtime.example/', priority: 10 },
      ],
    });

    const encoded = encodePairingConnectionPayload(payload);

    expect(encoded.startsWith('openchamber://connect?v=2&p=')).toBe(true);
    expect(parsePairingConnectionPayload(encoded)).toEqual({
      ...payload,
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 20 },
        { type: 'tunnel', url: 'https://runtime.example', priority: 10 },
      ],
    });
  });

  test('round-trips a relay candidate (transport, not a URL)', () => {
    const payload = buildPairingConnectionPayload({
      pairingId: 'pair_relay',
      secret: 'one-time-secret',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
      ],
    });

    const parsed = parsePairingConnectionPayload(encodePairingConnectionPayload(payload));
    expect(parsed?.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
      { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
    ]);
  });

  test('relay candidate keeps its path and rejects non-ws relay URLs / bad JWKs', () => {
    const withBadRelay = (candidate: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ v: 2, pairingId: 'pair_1', secret: 's', candidates: [candidate] })).toString('base64url');

    // https relay URL is not a WebSocket endpoint → candidate dropped → no candidates → null.
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${withBadRelay({ type: 'relay', relayUrl: 'https://relay.example/ws', serverId: 'srv', hostEncPubJwk })}`)).toBeNull();
    // Missing serverId.
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${withBadRelay({ type: 'relay', relayUrl: 'wss://relay.example/ws', hostEncPubJwk })}`)).toBeNull();
    // Non-P-256 key.
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${withBadRelay({ type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv', hostEncPubJwk: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } })}`)).toBeNull();
  });

  test('drops a private-key member from a relay JWK (keeps only public coordinates)', () => {
    const withKey = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_1',
      secret: 's',
      candidates: [{ type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv', hostEncPubJwk: { ...hostEncPubJwk, d: 'PRIVATE' } }],
    })).toString('base64url');
    const parsed = parsePairingConnectionPayload(`openchamber://connect?v=2&p=${withKey}`);
    expect(parsed?.candidates[0]).toEqual({ type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv', hostEncPubJwk });
  });

  test('normalizes a strict direct E2EE candidate and drops private JWK fields', () => {
    const encoded = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_direct_e2ee',
      secret: 'secret',
      candidates: [{
        type: 'direct-e2ee',
        wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws',
        hostEncPubJwk: { ...hostEncPubJwk, d: 'private', unknown: true },
      }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${encoded}`)?.candidates).toEqual([{
      type: 'direct-e2ee',
      wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws',
      hostEncPubJwk,
    }]);
  });

  test('drops unsafe direct E2EE candidates and unknown candidate types', () => {
    for (const wssUrl of [
      'https://host.example/api/openchamber/direct-e2ee/ws',
      'ws://host.example/api/openchamber/direct-e2ee/ws',
      'wss://user:pass@host.example/api/openchamber/direct-e2ee/ws',
      'wss://host.example/api/openchamber/direct-e2ee/ws?token=x',
      'wss://host.example/api/openchamber/direct-e2ee/ws#fragment',
      'wss://host.example/wrong',
    ]) {
      const encoded = Buffer.from(JSON.stringify({ v: 2, pairingId: 'p', secret: 's', candidates: [{ type: 'direct-e2ee', wssUrl, hostEncPubJwk }] })).toString('base64url');
      expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${encoded}`)).toBeNull();
    }
  });

  test('rejects invalid v2 pairing payloads', () => {
    expect(parsePairingConnectionPayload('openchamber://connect?v=1&server=https://runtime.example&token=t')).toBeNull();
    expect(parsePairingConnectionPayload('openchamber://connect?v=2&p=not-json')).toBeNull();

    const missingSecret = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      candidates: [{ type: 'lan', url: 'http://runtime.example' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${missingSecret}`)).toBeNull();

    const invalidCandidate = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      secret: 'secret',
      candidates: [{ type: 'lan', url: 'file:///tmp/socket' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${invalidCandidate}`)).toBeNull();

    const expired = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      secret: 'secret',
      expiresAt: '2000-01-01T00:00:00.000Z',
      candidates: [{ type: 'lan', url: 'http://runtime.example' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${expired}`)).toBeNull();
  });
});
