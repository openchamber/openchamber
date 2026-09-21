// E2EE primitives for the private relay (Layer 2 of the protocol spec).
// WebCrypto only — isomorphic across browser, Node >= 20, WKWebView, and Workers.
// Key agreement: ECDH P-256 -> HKDF-SHA-256 -> two AES-256-GCM keys (one per direction).
// Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 2).

import {
  ENCRYPTED_FRAME_HEADER_BYTES,
  ENCRYPTED_FRAME_IV_BYTES,
  ENCRYPTED_FRAME_VERSION,
  MAX_PLAINTEXT_FRAME_BYTES,
  RELAY_HKDF_INFO,
} from './protocol';

const subtle = globalThis.crypto.subtle;

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const HANDSHAKE_NONCE_BYTES = 16;
const SESSION_KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;
// IV = 4-byte random per-direction prefix || 8-byte big-endian frame counter.
const IV_PREFIX_BYTES = 4;
const IV_COUNTER_BYTES = 8;

export class RelayCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayCryptoError';
  }
}

export const generateEcdhKeyPair = (): Promise<CryptoKeyPair> =>
  subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);

export const exportPublicKeyJwk = async (key: CryptoKey): Promise<JsonWebKey> => {
  const jwk = await subtle.exportKey('jwk', key);
  // Keep only the fields that define the public point so serialized forms compare stably.
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
};

export const importEcdhPublicKey = async (jwk: JsonWebKey): Promise<CryptoKey> => {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new RelayCryptoError('invalid ECDH public key JWK');
  }
  try {
    return await subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      ECDH_PARAMS,
      true,
      [],
    );
  } catch {
    throw new RelayCryptoError('invalid ECDH public key JWK');
  }
};

// Stable fingerprint of a public key, used to detect rekey attempts on re-hello.
export const publicKeyJwkFingerprint = (jwk: JsonWebKey): string =>
  JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

export const generateHandshakeNonce = (): Uint8Array => {
  const nonce = new Uint8Array(HANDSHAKE_NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  return nonce;
};

export interface SessionKeys {
  clientToHost: CryptoKey;
  hostToClient: CryptoKey;
}

// Both sides call this with their own private key and the peer's public key;
// ECDH yields the same shared secret, so the derived key pair matches.
export const deriveSessionKeys = async (
  ownPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  handshakeNonce: Uint8Array,
): Promise<SessionKeys> => {
  if (handshakeNonce.length !== HANDSHAKE_NONCE_BYTES) {
    throw new RelayCryptoError('invalid handshake nonce length');
  }
  const sharedSecret = await subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    ownPrivateKey,
    256,
  );
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const keyMaterial = new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: handshakeNonce as BufferSource,
        info: new TextEncoder().encode(RELAY_HKDF_INFO),
      },
      hkdfKey,
      SESSION_KEY_BYTES * 2 * 8,
    ),
  );
  const importAesKey = (bytes: Uint8Array, usage: KeyUsage[]) =>
    subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, usage);
  return {
    clientToHost: await importAesKey(keyMaterial.slice(0, SESSION_KEY_BYTES), ['encrypt', 'decrypt']),
    hostToClient: await importAesKey(keyMaterial.slice(SESSION_KEY_BYTES), ['encrypt', 'decrypt']),
  };
};

export interface FrameEncryptor {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
}

export interface FrameDecryptor {
  decrypt(frame: Uint8Array): Promise<Uint8Array>;
}

const writeCounter = (target: Uint8Array, offset: number, counter: bigint): void => {
  for (let i = IV_COUNTER_BYTES - 1; i >= 0; i -= 1) {
    target[offset + i] = Number(counter & 0xffn);
    counter >>= 8n;
  }
};

const readCounter = (source: Uint8Array, offset: number): bigint => {
  let value = 0n;
  for (let i = 0; i < IV_COUNTER_BYTES; i += 1) {
    value = (value << 8n) | BigInt(source[offset + i]);
  }
  return value;
};

export const createFrameEncryptor = (key: CryptoKey): FrameEncryptor => {
  const ivPrefix = new Uint8Array(IV_PREFIX_BYTES);
  globalThis.crypto.getRandomValues(ivPrefix);
  let counter = 0n;
  return {
    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
      if (plaintext.length > MAX_PLAINTEXT_FRAME_BYTES) {
        throw new RelayCryptoError('plaintext frame exceeds maximum size');
      }
      counter += 1n;
      const iv = new Uint8Array(ENCRYPTED_FRAME_IV_BYTES);
      iv.set(ivPrefix, 0);
      writeCounter(iv, IV_PREFIX_BYTES, counter);
      const ciphertext = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource),
      );
      const frame = new Uint8Array(ENCRYPTED_FRAME_HEADER_BYTES + ciphertext.length);
      frame[0] = ENCRYPTED_FRAME_VERSION;
      frame.set(iv, 1);
      frame.set(ciphertext, ENCRYPTED_FRAME_HEADER_BYTES);
      return frame;
    },
  };
};

// Enforces strictly increasing per-direction counters: the relay WS preserves
// ordering, so any regression or replay means tampering and must fail closed.
export const createFrameDecryptor = (key: CryptoKey): FrameDecryptor => {
  let lastCounter = 0n;
  return {
    async decrypt(frame: Uint8Array): Promise<Uint8Array> {
      if (frame.length < ENCRYPTED_FRAME_HEADER_BYTES + GCM_TAG_BYTES) {
        throw new RelayCryptoError('encrypted frame too short');
      }
      if (frame[0] !== ENCRYPTED_FRAME_VERSION) {
        throw new RelayCryptoError('unsupported encrypted frame version');
      }
      const iv = frame.slice(1, ENCRYPTED_FRAME_HEADER_BYTES);
      const counter = readCounter(iv, IV_PREFIX_BYTES);
      if (counter <= lastCounter) {
        throw new RelayCryptoError('frame counter regression');
      }
      let plaintext: ArrayBuffer;
      try {
        plaintext = await subtle.decrypt(
          { name: 'AES-GCM', iv: iv as BufferSource },
          key,
          frame.slice(ENCRYPTED_FRAME_HEADER_BYTES) as BufferSource,
        );
      } catch {
        throw new RelayCryptoError('frame decryption failed');
      }
      lastCounter = counter;
      return new Uint8Array(plaintext);
    },
  };
};

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
};

export const base64UrlToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new RelayCryptoError('invalid base64url input');
  }
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out;
};
