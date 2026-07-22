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
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   readSettingsStrict?: () => Promise<object>,
 * }} deps
 */
export const createRelayIdentityRuntime = (deps) => {
  const { crypto, readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict } = deps;

  let cachedIdentity = null;

  const getOrCreateEncryptionKeypair = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const existing = settings?.relayEncryptionKey;
    if (isJwkPair(existing)) {
      return existing;
    }
    // Same regeneration gate as the signing key: never mint a replacement
    // identity key off a swallowed read failure — a new encryption key breaks
    // the E2EE trust anchor pinned by every paired device. Verify "missing" via
    // the strict reader (throws on corrupt/unreadable) before generating.
    let verifiedSettings = settings;
    if (readSettingsStrict) {
      verifiedSettings = await readSettingsStrict();
      const verified = verifiedSettings?.relayEncryptionKey;
      if (isJwkPair(verified)) {
        return verified;
      }
    }
    // Loud on purpose: a new encryption key invalidates the E2EE trust anchor of
    // every paired device. Expected exactly once, on first relay use.
    console.warn('[relay-identity] Generating NEW relay encryption keypair (E2EE trust anchor changes; previously paired devices must re-pair)');
    const keyPair = await generateEcdhKeyPair();
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const publicJwk = await exportPublicKeyJwk(keyPair.publicKey);
    await writeSettingsToDisk({ ...settings, ...(verifiedSettings || {}), relayEncryptionKey: { privateJwk, publicJwk } });
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
    const signing = await getOrCreateRelaySigningKeypair({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict });
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
