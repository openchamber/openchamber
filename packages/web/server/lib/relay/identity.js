// Host relay identity: the EXISTING ECDSA P-256 signing keypair (shared with
// the push relay via signing-key.js — same storage, same serverId) plus a NEW
// long-lived ECDH P-256 encryption keypair for the E2EE channel (WebCrypto
// keys are single-purpose, so signing and encryption keys must differ).
// The encryption keypair is persisted as `settings.relayEncryptionKey =
// { privateJwk, publicJwk }`, mirroring the relaySigningKey precedent.

import {
  canonicalPublicJwkString,
  deriveServerId,
  getOrCreateRelaySigningKeypair,
  signRelayMessage,
} from './signing-key.js';
import { exportPublicKeyJwk, generateEcdhKeyPair, importEcdhPrivateKey } from './e2ee.js';

const isJwkPair = (value) => Boolean(value && typeof value === 'object' && value.privateJwk && value.publicJwk);

/**
 * @param {{ crypto: typeof import('node:crypto'), readSettingsFromDiskMigrated: () => Promise<object>, writeSettingsToDisk: (settings: object) => Promise<void> }} deps
 */
export const createRelayIdentityRuntime = (deps) => {
  const { crypto, readSettingsFromDiskMigrated, writeSettingsToDisk } = deps;

  let cachedIdentity = null;

  const getOrCreateEncryptionKeypair = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const existing = settings?.relayEncryptionKey;
    if (isJwkPair(existing)) {
      return existing;
    }
    const keyPair = await generateEcdhKeyPair();
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const publicJwk = await exportPublicKeyJwk(keyPair.publicKey);
    await writeSettingsToDisk({ ...settings, relayEncryptionKey: { privateJwk, publicJwk } });
    return { privateJwk, publicJwk };
  };

  /**
   * @returns {Promise<{
   *   serverId: string,
   *   hostEncPubJwk: JsonWebKey,
   *   hostEncPrivateKey: CryptoKey,
   *   signRelayAuth: (role: string, connectionId?: string | null) => { ts: number, sig: string, pk: string },
   * }>}
   */
  const getRelayIdentity = async () => {
    if (cachedIdentity) return cachedIdentity;
    const signing = await getOrCreateRelaySigningKeypair({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk });
    const serverId = deriveServerId({ crypto }, signing.publicJwk);
    const encryption = await getOrCreateEncryptionKeypair();
    const hostEncPrivateKey = await importEcdhPrivateKey(encryption.privateJwk);
    const pk = Buffer.from(canonicalPublicJwkString(signing.publicJwk), 'utf8').toString('base64url');

    // Relay-layer auth for host-control / host-data upgrades. Signature payload
    // string is `${ts}.${serverId}.${role}.${connectionId ?? ""}` (spec Layer 1).
    const signRelayAuth = (role, connectionId) => {
      const ts = Date.now();
      const sig = signRelayMessage({ crypto }, signing.privateKey, `${ts}.${serverId}.${role}.${connectionId ?? ''}`);
      return { ts, sig, pk };
    };

    cachedIdentity = {
      serverId,
      hostEncPubJwk: encryption.publicJwk,
      hostEncPrivateKey,
      signRelayAuth,
    };
    return cachedIdentity;
  };

  return { getRelayIdentity };
};
