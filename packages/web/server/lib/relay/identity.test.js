import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';

import { createRelayIdentityRuntime } from './identity.js';
import { canonicalPublicJwkString } from './signing-key.js';

// In-memory settings store standing in for the on-disk settings file.
const makeSettingsStore = (initial = {}) => {
  let settings = { ...initial };
  return {
    readSettingsFromDiskMigrated: async () => ({ ...settings }),
    writeSettingsToDisk: async (next) => {
      settings = { ...next };
    },
    peek: () => settings,
  };
};

describe('relay identity', () => {
  it('derives a stable serverId from the signing key and persists both keypairs', async () => {
    const store = makeSettingsStore();
    const runtime = createRelayIdentityRuntime({ crypto, ...store });
    const identity = await runtime.getRelayIdentity();

    const stored = store.peek();
    expect(stored.relaySigningKey).toBeDefined();
    expect(stored.relayEncryptionKey).toBeDefined();

    const expectedServerId = crypto
      .createHash('sha256')
      .update(canonicalPublicJwkString(stored.relaySigningKey.publicJwk))
      .digest('base64url');
    expect(identity.serverId).toBe(expectedServerId);
    expect(identity.hostEncPubJwk.crv).toBe('P-256');
  });

  it('reuses an existing signing key (serverId stays stable across installs)', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    void privateKey;
    const publicJwk = publicKey.export({ format: 'jwk' });
    const store = makeSettingsStore({
      relaySigningKey: {
        privateJwk: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
        publicJwk,
      },
    });
    // Match private to public so importing works.
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    store.peek().relaySigningKey.privateJwk = pair.privateKey.export({ format: 'jwk' });
    store.peek().relaySigningKey.publicJwk = pair.publicKey.export({ format: 'jwk' });

    const runtime = createRelayIdentityRuntime({ crypto, ...store });
    const identity = await runtime.getRelayIdentity();
    const expected = crypto
      .createHash('sha256')
      .update(canonicalPublicJwkString(pair.publicKey.export({ format: 'jwk' })))
      .digest('base64url');
    expect(identity.serverId).toBe(expected);
  });

  it('produces a verifiable relay auth signature', async () => {
    const store = makeSettingsStore();
    const runtime = createRelayIdentityRuntime({ crypto, ...store });
    const identity = await runtime.getRelayIdentity();
    const { ts, sig, pk } = identity.signRelayAuth('host-control', null);

    const canonical = Buffer.from(pk, 'base64url').toString('utf8');
    const publicJwk = JSON.parse(canonical);
    const key = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
    const ok = crypto.verify(
      'SHA256',
      Buffer.from(`${ts}.${identity.serverId}.host-control.`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('derives and repairs the public encryption JWK from a valid persisted private key', async () => {
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
    const other = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const mismatched = await globalThis.crypto.subtle.exportKey('jwk', other.publicKey);
    const store = makeSettingsStore({ relayEncryptionKey: { privateJwk, publicJwk: { ...mismatched, d: 'leak' } } });
    const identity = await createRelayIdentityRuntime({ crypto, ...store }).getRelayIdentity();
    expect(identity.hostEncPubJwk).toEqual({ kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y });
    expect(identity.hostEncPubJwk).not.toHaveProperty('d');
    expect(store.peek().relayEncryptionKey.privateJwk.d).toBe(privateJwk.d);
    expect(store.peek().relayEncryptionKey.publicJwk).toEqual(identity.hostEncPubJwk);
  });

  it('replaces an invalid persisted private encryption point', async () => {
    const store = makeSettingsStore({
      relayEncryptionKey: {
        privateJwk: { kty: 'EC', crv: 'P-256', x: 'bad', y: 'bad', d: 'bad' },
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'bad', y: 'bad', d: 'leak' },
      },
    });
    const identity = await createRelayIdentityRuntime({ crypto, ...store }).getRelayIdentity();
    expect(identity.hostEncPubJwk).not.toHaveProperty('d');
    expect(identity.hostEncPubJwk.x).not.toBe('bad');
    expect(store.peek().relayEncryptionKey.privateJwk.d).not.toBe('bad');
  });
});
