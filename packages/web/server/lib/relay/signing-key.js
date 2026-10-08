// Per-server relay signing identity (ECDSA P-256), extracted from
// lib/notifications/apns-runtime.js so both the push relay and the private
// relay share the SAME keypair and thus the SAME serverId
// (base64url(SHA-256(canonical public JWK))). Stored by key-store.js; existing
// installs' serverId must stay stable because push token binding depends on it.

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   relayKeyStore: ReturnType<typeof import('./key-store.js').createRelayKeyStore>,
 * }} deps
 * @returns {Promise<{ privateKey: import('node:crypto').KeyObject, publicJwk: JsonWebKey }>}
 */
export const getOrCreateRelaySigningKeypair = async ({ crypto, relayKeyStore }) => {
  const stored = await relayKeyStore.getOrCreate('signing', async () => {
    // Loud on purpose: a new signing key means a new serverId — every previously
    // paired device and push binding is orphaned. Expected exactly once, on first run.
    console.warn('[relay-identity] Generating NEW relay signing keypair (serverId changes; previously paired devices must re-pair)');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return { privateJwk: privateKey.export({ format: 'jwk' }), publicJwk: publicKey.export({ format: 'jwk' }) };
  });
  return {
    privateKey: crypto.createPrivateKey({ key: stored.privateJwk, format: 'jwk' }),
    publicJwk: stored.publicJwk,
  };
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
