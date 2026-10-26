import { describe, expect, test } from 'bun:test';

import {
  base64UrlToBytes,
  bytesToBase64Url,
  createFrameDecryptor,
  createFrameEncryptor,
  deriveSessionKeys,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  generateHandshakeNonce,
  importEcdhPublicKey,
  publicKeyJwkFingerprint,
  RelayCryptoError,
} from './crypto';
import { ENCRYPTED_FRAME_HEADER_BYTES, MAX_PLAINTEXT_FRAME_BYTES } from './protocol';

const setupSession = async () => {
  const host = await generateEcdhKeyPair();
  const client = await generateEcdhKeyPair();
  const nonce = generateHandshakeNonce();
  const hostPub = await importEcdhPublicKey(await exportPublicKeyJwk(host.publicKey));
  const clientPub = await importEcdhPublicKey(await exportPublicKeyJwk(client.publicKey));
  const clientKeys = await deriveSessionKeys(client.privateKey, hostPub, nonce);
  const hostKeys = await deriveSessionKeys(host.privateKey, clientPub, nonce);
  return { clientKeys, hostKeys };
};

describe('relay crypto', () => {
  test('both sides derive matching directional keys (round trip both ways)', async () => {
    const { clientKeys, hostKeys } = await setupSession();

    const clientToHost = createFrameEncryptor(clientKeys.clientToHost);
    const hostReceives = createFrameDecryptor(hostKeys.clientToHost);
    const message = new TextEncoder().encode('hello from client');
    const decrypted = await hostReceives.decrypt(await clientToHost.encrypt(message));
    expect(new TextDecoder().decode(decrypted)).toBe('hello from client');

    const hostToClient = createFrameEncryptor(hostKeys.hostToClient);
    const clientReceives = createFrameDecryptor(clientKeys.hostToClient);
    const reply = new TextEncoder().encode('hello from host');
    const decryptedReply = await clientReceives.decrypt(await hostToClient.encrypt(reply));
    expect(new TextDecoder().decode(decryptedReply)).toBe('hello from host');
  });

  test('different nonce yields incompatible keys', async () => {
    const host = await generateEcdhKeyPair();
    const client = await generateEcdhKeyPair();
    const hostPub = await importEcdhPublicKey(await exportPublicKeyJwk(host.publicKey));
    const clientPub = await importEcdhPublicKey(await exportPublicKeyJwk(client.publicKey));
    const clientKeys = await deriveSessionKeys(client.privateKey, hostPub, generateHandshakeNonce());
    const hostKeys = await deriveSessionKeys(host.privateKey, clientPub, generateHandshakeNonce());
    const frame = await createFrameEncryptor(clientKeys.clientToHost).encrypt(new Uint8Array([1, 2, 3]));
    await expect(createFrameDecryptor(hostKeys.clientToHost).decrypt(frame)).rejects.toThrow(RelayCryptoError);
  });

  test('tampered ciphertext is rejected', async () => {
    const { clientKeys, hostKeys } = await setupSession();
    const frame = await createFrameEncryptor(clientKeys.clientToHost).encrypt(new Uint8Array([9, 9, 9]));
    frame[frame.length - 1] ^= 0x01;
    await expect(createFrameDecryptor(hostKeys.clientToHost).decrypt(frame)).rejects.toThrow(
      'frame decryption failed',
    );
  });

  test('replayed and reordered frames are rejected (counter regression)', async () => {
    const { clientKeys, hostKeys } = await setupSession();
    const encryptor = createFrameEncryptor(clientKeys.clientToHost);
    const decryptor = createFrameDecryptor(hostKeys.clientToHost);
    const first = await encryptor.encrypt(new Uint8Array([1]));
    const second = await encryptor.encrypt(new Uint8Array([2]));
    await decryptor.decrypt(first);
    await decryptor.decrypt(second);
    await expect(decryptor.decrypt(first)).rejects.toThrow('frame counter regression');
  });

  test('skipped counters are tolerated but never regress', async () => {
    const { clientKeys, hostKeys } = await setupSession();
    const encryptor = createFrameEncryptor(clientKeys.clientToHost);
    const decryptor = createFrameDecryptor(hostKeys.clientToHost);
    const first = await encryptor.encrypt(new Uint8Array([1]));
    const second = await encryptor.encrypt(new Uint8Array([2]));
    const third = await encryptor.encrypt(new Uint8Array([3]));
    await decryptor.decrypt(first);
    await decryptor.decrypt(third);
    await expect(decryptor.decrypt(second)).rejects.toThrow('frame counter regression');
  });

  test('oversized plaintext is rejected before encryption', async () => {
    const { clientKeys } = await setupSession();
    const encryptor = createFrameEncryptor(clientKeys.clientToHost);
    await expect(encryptor.encrypt(new Uint8Array(MAX_PLAINTEXT_FRAME_BYTES + 1))).rejects.toThrow(
      'plaintext frame exceeds maximum size',
    );
  });

  test('truncated and wrong-version frames are rejected', async () => {
    const { hostKeys } = await setupSession();
    const decryptor = createFrameDecryptor(hostKeys.clientToHost);
    await expect(decryptor.decrypt(new Uint8Array(ENCRYPTED_FRAME_HEADER_BYTES))).rejects.toThrow(
      'encrypted frame too short',
    );
    const bogus = new Uint8Array(ENCRYPTED_FRAME_HEADER_BYTES + 20);
    bogus[0] = 42;
    await expect(decryptor.decrypt(bogus)).rejects.toThrow('unsupported encrypted frame version');
  });

  test('importEcdhPublicKey rejects malformed JWKs', async () => {
    await expect(importEcdhPublicKey({ kty: 'RSA' })).rejects.toThrow(RelayCryptoError);
    await expect(importEcdhPublicKey({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' })).rejects.toThrow(
      RelayCryptoError,
    );
    await expect(importEcdhPublicKey({ kty: 'EC', crv: 'P-256', x: '!!', y: '!!' })).rejects.toThrow(
      RelayCryptoError,
    );
  });

  test('fingerprint is stable across key-order differences and distinct per key', async () => {
    const pair = await generateEcdhKeyPair();
    const jwk = await exportPublicKeyJwk(pair.publicKey);
    const shuffled: JsonWebKey = { y: jwk.y, x: jwk.x, crv: jwk.crv, kty: jwk.kty };
    expect(publicKeyJwkFingerprint(jwk)).toBe(publicKeyJwkFingerprint(shuffled));
    const other = await exportPublicKeyJwk((await generateEcdhKeyPair()).publicKey);
    expect(publicKeyJwkFingerprint(jwk)).not.toBe(publicKeyJwkFingerprint(other));
  });

  test('base64url round trip and rejection of invalid input', () => {
    for (const length of [0, 1, 2, 3, 16, 31, 32]) {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    }
    expect(() => base64UrlToBytes('a+b/c=')).toThrow(RelayCryptoError);
    expect(() => base64UrlToBytes('abcde')).toThrow(RelayCryptoError);
  });
});
