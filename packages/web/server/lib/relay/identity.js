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
import { exportPublicKeyJwk, generateEcdhKeyPair, importEcdhPrivateKey, importEcdhPublicKey } from './e2ee.js';

const publicJwkFromPrivate = (privateJwk) => ({
  kty: privateJwk?.kty,
  crv: privateJwk?.crv,
  x: privateJwk?.x,
  y: privateJwk?.y,
});

const samePublicJwk = (left, right) =>
  left?.kty === right.kty && left?.crv === right.crv && left?.x === right.x && left?.y === right.y
  && Object.keys(left).every((key) => ['kty', 'crv', 'x', 'y'].includes(key));

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
  let cachedIdentityGeneration = null;
  let pendingIdentity = null;
  let identityGeneration = 0;

  const generationSupersededError = () => Object.assign(
    new Error('Relay identity initialization superseded'),
    {
      name: 'RelayIdentityGenerationSupersededError',
      code: 'relay_identity_generation_superseded',
    },
  );

  const assertCurrentGeneration = (generation) => {
    if (generation !== identityGeneration) throw generationSupersededError();
  };

  const writeSettingsForGeneration = async (generation, settings) => {
    assertCurrentGeneration(generation);
    await writeSettingsToDisk(settings);
    assertCurrentGeneration(generation);
  };

  const importPersistedEncryptionKeypair = async (generation, settings) => {
    const existing = settings?.relayEncryptionKey;
    if (!existing?.privateJwk) return null;
    try {
      const privateKey = await importEcdhPrivateKey(existing.privateJwk);
      const publicJwk = publicJwkFromPrivate(existing.privateJwk);
      await importEcdhPublicKey(publicJwk);
      if (!samePublicJwk(existing.publicJwk, publicJwk)) {
        await writeSettingsForGeneration(generation, { ...settings, relayEncryptionKey: { privateJwk: existing.privateJwk, publicJwk } });
      }
      return { privateJwk: existing.privateJwk, publicJwk, privateKey };
    } catch {
      // Invalid private material cannot be repaired; replace the keypair only
      // after the strict settings read confirms regeneration is safe.
      return null;
    }
  };

  const getOrCreateEncryptionKeypair = async (generation) => {
    const settings = await readSettingsFromDiskMigrated();
    assertCurrentGeneration(generation);
    const existing = await importPersistedEncryptionKeypair(generation, settings);
    if (existing) return existing;

    // Same regeneration gate as the signing key: never mint a replacement
    // identity key off a swallowed read failure — a new encryption key breaks
    // the E2EE trust anchor pinned by every paired device. Verify "missing" via
    // the strict reader (throws on corrupt/unreadable) before generating.
    let verifiedSettings = settings;
    if (readSettingsStrict) {
      verifiedSettings = await readSettingsStrict();
      assertCurrentGeneration(generation);
      const verified = await importPersistedEncryptionKeypair(generation, verifiedSettings);
      if (verified) return verified;
    }
    // Loud on purpose: a new encryption key invalidates the E2EE trust anchor of
    // every paired device. Expected exactly once, on first relay use.
    console.warn('[relay-identity] Generating NEW relay encryption keypair (E2EE trust anchor changes; previously paired devices must re-pair)');
    const keyPair = await generateEcdhKeyPair();
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const publicJwk = await exportPublicKeyJwk(keyPair.publicKey);
    await writeSettingsForGeneration(generation, { ...settings, ...(verifiedSettings || {}), relayEncryptionKey: { privateJwk, publicJwk } });
    return { privateJwk, publicJwk, privateKey: keyPair.privateKey };
  };

  /**
   * @returns {Promise<{
   *   serverId: string,
   *   hostEncPubJwk: JsonWebKey,
   *   hostEncPrivateKey: CryptoKey,
   *   signRelayAuth: (role: string, connectionId?: string | null) => { ts: number, sig: string, pk: string },
   * }>}
   */
  const initializeRelayIdentity = async (generation) => {
    if (cachedIdentity && cachedIdentityGeneration === generation) return cachedIdentity;
    const signing = await getOrCreateRelaySigningKeypair({
      crypto,
      readSettingsFromDiskMigrated,
      writeSettingsToDisk: (settings) => writeSettingsForGeneration(generation, settings),
      readSettingsStrict,
    });
    assertCurrentGeneration(generation);
    const serverId = deriveServerId({ crypto }, signing.publicJwk);
    const encryption = await getOrCreateEncryptionKeypair(generation);
    const hostEncPrivateKey = encryption.privateKey || await importEcdhPrivateKey(encryption.privateJwk);
    const pk = Buffer.from(canonicalPublicJwkString(signing.publicJwk), 'utf8').toString('base64url');

    // Relay-layer auth for host-control / host-data upgrades. Signature payload
    // string is `${ts}.${serverId}.${role}.${connectionId ?? ""}` (spec Layer 1).
    const signRelayAuth = (role, connectionId) => {
      const ts = Date.now();
      const sig = signRelayMessage({ crypto }, signing.privateKey, `${ts}.${serverId}.${role}.${connectionId ?? ''}`);
      return { ts, sig, pk };
    };

    assertCurrentGeneration(generation);
    cachedIdentity = {
      serverId,
      hostEncPubJwk: encryption.publicJwk,
      hostEncPrivateKey,
      signRelayAuth,
    };
    cachedIdentityGeneration = generation;
    return cachedIdentity;
  };

  const getRelayIdentity = () => {
    if (cachedIdentity && cachedIdentityGeneration === identityGeneration) return Promise.resolve(cachedIdentity);
    if (pendingIdentity?.generation === identityGeneration) return pendingIdentity.promise;

    const generation = identityGeneration;
    const promise = initializeRelayIdentity(generation).catch((error) => {
      if (generation !== identityGeneration) throw generationSupersededError();
      throw error;
    }).finally(() => {
      if (pendingIdentity?.generation === generation) pendingIdentity = null;
    });
    pendingIdentity = { generation, promise };
    return promise;
  };

  const abandonPendingRelayIdentity = () => {
    if (cachedIdentity && cachedIdentityGeneration === identityGeneration) return false;
    if (pendingIdentity?.generation !== identityGeneration) return false;
    identityGeneration += 1;
    pendingIdentity = null;
    return true;
  };

  return { abandonPendingRelayIdentity, getRelayIdentity };
};
