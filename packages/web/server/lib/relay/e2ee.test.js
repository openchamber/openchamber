import { describe, expect, it } from 'bun:test';

import {
  base64UrlToBytes,
  bytesToBase64Url,
  createFrameDecryptor,
  createFrameEncryptor,
  createHostHandshake,
  deriveSessionKeys,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  generateHandshakeNonce,
  RELAY_PROTOCOL_VERSION,
} from './e2ee.js';

const subtle = globalThis.crypto.subtle;

// A minimal client-side initiator so the host handshake can be exercised
// end-to-end without importing the browser TS modules.
const createClientHandshake = async (hostEncPubJwk) => {
  const hostPublicKey = await subtle.importKey(
    'jwk',
    { kty: hostEncPubJwk.kty, crv: hostEncPubJwk.crv, x: hostEncPubJwk.x, y: hostEncPubJwk.y, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  const ephemeral = await generateEcdhKeyPair();
  const nonce = generateHandshakeNonce();
  const helloText = JSON.stringify({
    t: 'hello',
    v: RELAY_PROTOCOL_VERSION,
    clientPubJwk: await exportPublicKeyJwk(ephemeral.publicKey),
    nonce: bytesToBase64Url(nonce),
  });
  const deriveChannel = async () => {
    const keys = await deriveSessionKeys(ephemeral.privateKey, hostPublicKey, nonce);
    return {
      encryptor: createFrameEncryptor(keys.clientToHost),
      decryptor: createFrameDecryptor(keys.hostToClient),
    };
  };
  return { helloText, deriveChannel };
};

describe('relay e2ee', () => {
  it('round-trips frames in both directions after handshake', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);
    const host = createHostHandshake(hostKeys.privateKey);
    const client = await createClientHandshake(hostPubJwk);

    const action = await host.handleText(client.helloText);
    expect(action.type).toBe('established');
    const hostChannel = action.channel;
    const clientChannel = await client.deriveChannel();

    const c2h = new TextEncoder().encode('client-to-host payload');
    const decodedAtHost = await hostChannel.decryptor.decrypt(await clientChannel.encryptor.encrypt(c2h));
    expect(new TextDecoder().decode(decodedAtHost)).toBe('client-to-host payload');

    const h2c = new TextEncoder().encode('host-to-client payload');
    const decodedAtClient = await clientChannel.decryptor.decrypt(await hostChannel.encryptor.encrypt(h2c));
    expect(new TextDecoder().decode(decodedAtClient)).toBe('host-to-client payload');
  });

  it('rejects tampered ciphertext', async () => {
    const keyBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(keyBytes);
    const key = await subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const enc = createFrameEncryptor(key);
    const dec = createFrameDecryptor(key);
    const frame = await enc.encrypt(new Uint8Array([1, 2, 3]));
    frame[frame.length - 1] ^= 0xff;
    await expect(dec.decrypt(frame)).rejects.toThrow();
  });

  it('rejects counter regression / replay', async () => {
    const keyBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(keyBytes);
    const key = await subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const enc = createFrameEncryptor(key);
    const dec = createFrameDecryptor(key);
    const first = await enc.encrypt(new Uint8Array([9]));
    await dec.decrypt(first);
    // Replaying the same frame (counter no longer strictly increasing) fails.
    await expect(dec.decrypt(first)).rejects.toThrow('frame counter regression');
  });

  it('re-sends ready on identical re-hello and fails on rekey', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);
    const host = createHostHandshake(hostKeys.privateKey);
    const client = await createClientHandshake(hostPubJwk);

    const first = await host.handleText(client.helloText);
    expect(first.type).toBe('established');

    const repeat = await host.handleText(client.helloText);
    expect(repeat.type).toBe('send-text');
    expect(repeat.text).toBe(first.replyText);

    const other = await createClientHandshake(hostPubJwk);
    const rekey = await host.handleText(other.helloText);
    expect(rekey.type).toBe('fail');
    expect(rekey.closeCode).toBe(1008);
  });

  it('fails closed on plaintext after ready', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);
    const host = createHostHandshake(hostKeys.privateKey);
    const client = await createClientHandshake(hostPubJwk);
    await host.handleText(client.helloText);
    const action = await host.handleText(JSON.stringify({ hello: 'not a handshake' }));
    expect(action.type).toBe('fail');
    expect(action.closeCode).toBe(1011);
  });

  it('base64url helpers round-trip', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(bytes)))).toEqual(Array.from(bytes));
  });
});
