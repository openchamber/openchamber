
import type { KeyObject } from 'node:crypto';
import type { RelayKeyStore, RelayPublicJwk } from './key-store.js';

export interface RelaySigningDependencies {
  crypto: typeof import('node:crypto');
  relayKeyStore: RelayKeyStore;
}

export interface RelaySigningKeypair {
  privateKey: KeyObject;
  publicJwk: RelayPublicJwk;
}

export const getOrCreateRelaySigningKeypair = async ({ crypto, relayKeyStore }: RelaySigningDependencies): Promise<RelaySigningKeypair> => {
  const stored = await relayKeyStore.getOrCreate('signing', async () => {
    console.warn('[relay-identity] Generating NEW relay signing keypair (serverId changes; previously paired devices must re-pair)');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return { privateJwk: privateKey.export({ format: 'jwk' }), publicJwk: publicKey.export({ format: 'jwk' }) };
  });
  return {
    privateKey: crypto.createPrivateKey({ key: { ...stored.privateJwk }, format: 'jwk' }),
    publicJwk: stored.publicJwk,
  };
};

export const canonicalPublicJwkString = (jwk: RelayPublicJwk) =>
  JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

export const deriveServerId = ({ crypto }: Pick<RelaySigningDependencies, 'crypto'>, publicJwk: RelayPublicJwk) =>
  crypto.createHash('sha256').update(canonicalPublicJwkString(publicJwk)).digest('base64url');

export const signRelayMessage = ({ crypto }: Pick<RelaySigningDependencies, 'crypto'>, privateKey: KeyObject, message: string) =>
  crypto.sign('SHA256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
