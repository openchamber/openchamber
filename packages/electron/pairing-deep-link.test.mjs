import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePairingDeepLink } from './pairing-deep-link.mjs';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'x-coordinate', y: 'y-coordinate' };
const relayCandidate = { type: 'relay', relayUrl: 'wss://relay.openchamber.dev/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 };

const linkFor = (payload) => `openchamber://connect?v=2&p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

const pairing = (candidates, extra = {}) => linkFor({ v: 2, pairingId: 'pair_1', secret: 'secret_1', label: 'Studio Mac', candidates, ...extra });

test('keeps a relay candidate, which carries no url', () => {
  assert.deepEqual(parsePairingDeepLink(pairing([relayCandidate])), {
    label: 'Studio Mac',
    fingerprint: '',
    target: 'relay://srv_abc',
  });
});

test('names the first direct address by priority when the link has one', () => {
  const parsed = parsePairingDeepLink(pairing([
    relayCandidate,
    { type: 'lan', url: 'http://127.0.0.1:4096/', priority: 10 },
    { type: 'tunnel', url: 'https://studio.example.com', priority: 20 },
  ]));
  assert.equal(parsed?.target, 'http://127.0.0.1:4096');
});

test('skips malformed candidates and rejects a link with none left', () => {
  const badRelay = { ...relayCandidate, relayUrl: 'https://relay.openchamber.dev/ws' };
  const badKey = { ...relayCandidate, hostEncPubJwk: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } };
  assert.equal(parsePairingDeepLink(pairing([badRelay, badKey, { type: 'lan', url: 'ftp://host' }])), null);
  assert.equal(parsePairingDeepLink(pairing([badRelay, relayCandidate]))?.target, 'relay://srv_abc');
});

test('rejects expired, secretless, and foreign links', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.equal(parsePairingDeepLink(pairing([relayCandidate], { expiresAt: '2026-10-08T11:59:00Z' }), { now }), null);
  assert.ok(parsePairingDeepLink(pairing([relayCandidate], { expiresAt: '2026-10-08T12:05:00Z' }), { now }));
  assert.equal(parsePairingDeepLink(pairing([relayCandidate], { secret: '' })), null);
  assert.equal(parsePairingDeepLink(pairing([relayCandidate]).replace('openchamber://', 'other://')), null);
  assert.equal(parsePairingDeepLink('openchamber://connect?v=2&p=not-json'), null);
});
