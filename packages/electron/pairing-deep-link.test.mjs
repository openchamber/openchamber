import { describe, expect, test } from 'bun:test';

import { decidePairingV2DeepLink } from './pairing-deep-link.mjs';

const link = (candidates, extra = {}) => {
  const payload = { v: 2, pairingId: 'pairing-id', secret: 'never-log-me', label: 'Friendly label', candidates, ...extra };
  return `openchamber://connect?v=2&p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
};
const lan = { type: 'lan', url: 'http://192.168.1.10:3000', priority: 10 };
const direct = { type: 'direct-e2ee', wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' }, priority: 1 };
const relay = { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, priority: 2 };

describe('Pairing v2 Electron deep-link decision', () => {
  test('rejects direct-E2EE-only before any lower-level handling', () => expect(decidePairingV2DeepLink(link([direct]))).toEqual({ kind: 'reject', reason: 'encrypted-candidate' }));
  test('rejects LAN plus direct-E2EE without plaintext downgrade', () => expect(decidePairingV2DeepLink(link([lan, direct]))).toEqual({ kind: 'reject', reason: 'encrypted-candidate' }));
  test('rejects relay plus LAN without plaintext downgrade', () => expect(decidePairingV2DeepLink(link([relay, lan]))).toEqual({ kind: 'reject', reason: 'encrypted-candidate' }));
  test('accepts valid HTTP-only Pairing v2 and keeps label separate from URL', () => {
    const result = decidePairingV2DeepLink(link([lan]));
    expect(result.kind).toBe('accept');
    if (result.kind === 'accept') {
      expect(result.payload.label).toBe('Friendly label');
      expect(result.payload.candidates).toEqual([{ ...lan, url: 'http://192.168.1.10:3000/' }]);
    }
  });
  test('rejects invalid and unknown candidates with fixed non-secret reasons', () => {
    for (const raw of ['not-a-link', link([{ type: 'unknown', url: 'https://secret.example' }])]) {
      const result = decidePairingV2DeepLink(raw);
      expect(result).toEqual({ kind: 'reject', reason: 'invalid' });
      expect(JSON.stringify(result)).not.toContain('never-log-me');
    }
  });
});
