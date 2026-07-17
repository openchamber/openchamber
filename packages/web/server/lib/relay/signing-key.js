// Per-server relay signing identity (ECDSA P-256), extracted from
// lib/notifications/apns-runtime.js so both the push relay and the private
// relay share the SAME keypair and thus the SAME serverId
// (base64url(SHA-256(canonical public JWK))). Storage format is unchanged:
// `settings.relaySigningKey = { privateJwk, publicJwk }` — existing installs'
// serverId must stay stable because push token binding depends on it.

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   readSettingsStrict?: () => Promise<object>,
 * }} deps
 * @returns {Promise<{ privateKey: import('node:crypto').KeyObject, publicJwk: JsonWebKey }>}
 */
export const getOrCreateRelaySigningKeypair = async ({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict }) => {
  const toKeypair = (stored) => ({
    privateKey: crypto.createPrivateKey({ key: stored.privateJwk, format: 'jwk' }),
    publicJwk: stored.publicJwk,
  });
  const settings = await readSettingsFromDiskMigrated();
  const existing = settings?.relaySigningKey;
  if (existing && existing.privateJwk && existing.publicJwk) {
    return toKeypair(existing);
  }
  // Regeneration gate: the lenient settings reader maps read failures to `{}`,
  // indistinguishable from "first run". Minting a new keypair changes serverId,
  // which orphans every paired device and push binding AND the write below would
  // clobber the settings file with the empty spread. Re-verify with the strict
  // reader (throws on corrupt/unreadable) before generating; if it finds the
  // key the lenient read lost, use it and generate nothing.
  let verifiedSettings = settings;
  if (readSettingsStrict) {
    verifiedSettings = await readSettingsStrict();
    const verified = verifiedSettings?.relaySigningKey;
    if (verified && verified.privateJwk && verified.publicJwk) {
      return toKeypair(verified);
    }
  }
  // Loud on purpose: a new signing key means a new serverId — every previously
  // paired device and push binding is orphaned. Expected exactly once, on first run.
  console.warn('[relay-identity] Generating NEW relay signing keypair (serverId changes; previously paired devices must re-pair)');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  await writeSettingsToDisk({ ...settings, ...(verifiedSettings || {}), relaySigningKey: { privateJwk, publicJwk } });
  return { privateKey, publicJwk };
};

// Fixed key order so the hash is stable regardless of stored JSON field order.
// Byte-for-byte mirror of canonicalJwk in openchamber-website apps/api relay-auth.ts.
/** @param {JsonWebKey} jwk */
export const canonicalPublicJwkString = (jwk) =>
  JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

/**
 * serverId = base64url(SHA-256(canonical public JWK)). Must match the push
 * relay's deriveServerId — this id is the routing key for both relays.
 * @param {{ crypto: typeof import('node:crypto') }} deps
 * @param {JsonWebKey} publicJwk
 */
export const deriveServerId = ({ crypto }, publicJwk) =>
  crypto.createHash('sha256').update(canonicalPublicJwkString(publicJwk)).digest('base64url');

/**
 * ECDSA-SHA256, IEEE P1363 (raw r||s) signature — the form WebCrypto verifies.
 * @param {{ crypto: typeof import('node:crypto') }} deps
 * @param {import('node:crypto').KeyObject} privateKey
 * @param {string} message
 */
export const signRelayMessage = ({ crypto }, privateKey, message) =>
  crypto.sign('SHA256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
