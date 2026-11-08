import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_HOST_ID,
  buildStoredHostEntry,
  normalizeHostUrl,
  sanitizeHostRelayForStorage,
} from './desktop-hosts-storage.mjs';

const RELAY = {
  relayUrl: 'wss://relay.example/rooms',
  serverId: 'srv_123',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x-value' },
};

test('a relay-only host keeps a learned direct address', () => {
  const stored = buildStoredHostEntry({
    id: 'host-1',
    url: 'relay://srv_123',
    apiUrl: 'http://192.0.2.10:57123',
    relay: RELAY,
  });

  assert.equal(stored.url, 'relay://srv_123');
  assert.equal(stored.apiUrl, 'http://192.0.2.10:57123/');
  assert.deepEqual(stored.relay, RELAY);
});

test('a relay-only host without a direct address stores none', () => {
  const stored = buildStoredHostEntry({ id: 'host-1', relay: RELAY });

  assert.equal(stored.url, 'relay://srv_123');
  assert.equal('apiUrl' in stored, false);
});

test('a relay host keeps its learned endpoint and credentials through a rename round-trip', () => {
  const stored = buildStoredHostEntry({
    id: 'host-1', label: 'Original', url: 'relay://srv_123',
    apiUrl: 'http://192.0.2.10:57123', clientToken: 'paired-token',
    requestHeaders: { 'X-Test': 'value' }, relay: RELAY,
  });

  const renamed = buildStoredHostEntry({ ...stored, label: 'Renamed' });
  assert.deepEqual(renamed, { ...stored, label: 'Renamed' });
  assert.deepEqual(buildStoredHostEntry(renamed), renamed);
});

test('a direct host falls its apiUrl back to its url', () => {
  const stored = buildStoredHostEntry({ id: 'host-2', url: 'http://192.0.2.10:57123' });

  assert.equal(stored.url, 'http://192.0.2.10:57123/');
  assert.equal(stored.apiUrl, 'http://192.0.2.10:57123/');
});

test('a multi-transport host keeps both transports and a distinct apiUrl', () => {
  const stored = buildStoredHostEntry({
    id: 'host-3',
    url: 'http://192.0.2.10:57123',
    apiUrl: 'http://192.0.2.11:57123',
    relay: RELAY,
  });

  assert.equal(stored.url, 'http://192.0.2.10:57123/');
  assert.equal(stored.apiUrl, 'http://192.0.2.11:57123/');
  assert.deepEqual(stored.relay, RELAY);
});

test('a non-http apiUrl is dropped, not stored', () => {
  const stored = buildStoredHostEntry({
    id: 'host-1',
    url: 'relay://srv_123',
    apiUrl: 'file:///etc/passwd',
    relay: RELAY,
  });

  assert.equal('apiUrl' in stored, false);
});

test('an entry with no usable transport is not stored', () => {
  assert.equal(buildStoredHostEntry({ id: 'host-4' }), null);
  assert.equal(buildStoredHostEntry({ id: LOCAL_HOST_ID, url: 'http://localhost:57123' }), null);
});

test('a malformed relay descriptor rejects the relay leg', () => {
  assert.equal(sanitizeHostRelayForStorage({ relayUrl: 'https://relay.example', serverId: 'srv', hostEncPubJwk: RELAY.hostEncPubJwk }), null);
  assert.equal(sanitizeHostRelayForStorage({ relayUrl: 'wss://relay.example', serverId: '' , hostEncPubJwk: RELAY.hostEncPubJwk }), null);
  assert.deepEqual(sanitizeHostRelayForStorage(RELAY), RELAY);
});

test('normalizeHostUrl canonicalizes http(s) and rejects other schemes', () => {
  assert.equal(normalizeHostUrl('HTTP://Example.test:57123/#frag'), 'http://example.test:57123/');
  assert.equal(normalizeHostUrl('relay://srv_123'), null);
  assert.equal(normalizeHostUrl('   '), null);
});
