
const subtle = globalThis.crypto.subtle;

export const RELAY_PROTOCOL_VERSION = 1;
const RELAY_HKDF_INFO = 'openchamber-relay-v1';

const ENCRYPTED_FRAME_VERSION = 1;
const ENCRYPTED_FRAME_IV_BYTES = 12;
const ENCRYPTED_FRAME_HEADER_BYTES = 1 + ENCRYPTED_FRAME_IV_BYTES;
export const MAX_PLAINTEXT_FRAME_BYTES = 64 * 1024;

export const RelayCloseCode = {
  ControlReplaced: 4001,
  RekeyMismatch: 1008,
  ChannelFailure: 1011,
};

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };
const HANDSHAKE_NONCE_BYTES = 16;
const SESSION_KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;
const IV_PREFIX_BYTES = 4;
const IV_COUNTER_BYTES = 8;

class RelayCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayCryptoError';
  }
}

export const generateEcdhKeyPair = (): Promise<CryptoKeyPair> => subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);

export const exportPublicKeyJwk = async (key: CryptoKey) => {
  const jwk = await subtle.exportKey('jwk', key);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
};

interface HandshakeJwk { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown }
const isHandshakeJwk = (value: unknown): value is HandshakeJwk => typeof value === 'object' && value !== null;
const isEcdhPublicKey = (jwk: HandshakeJwk): jwk is { kty: 'EC'; crv: 'P-256'; x: string; y: string } =>
  jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string';

const importEcdhPublicKey = async (jwk: HandshakeJwk) => {
  if (!isEcdhPublicKey(jwk)) {
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

export const importEcdhPrivateKey = async (jwk: JsonWebKey) => {
  try {
    return await subtle.importKey('jwk', jwk, ECDH_PARAMS, false, ['deriveBits']);
  } catch {
    throw new RelayCryptoError('invalid ECDH private key JWK');
  }
};

const publicKeyJwkFingerprint = (jwk: HandshakeJwk) =>
  JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

export const generateHandshakeNonce = () => {
  const nonce = new Uint8Array(HANDSHAKE_NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  return nonce;
};

export const deriveSessionKeys = async (ownPrivateKey: CryptoKey, peerPublicKey: CryptoKey, handshakeNonce: Uint8Array<ArrayBuffer>) => {
  if (handshakeNonce.length !== HANDSHAKE_NONCE_BYTES) {
    throw new RelayCryptoError('invalid handshake nonce length');
  }
  const sharedSecret = await subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, ownPrivateKey, 256);
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const keyMaterial = new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: handshakeNonce,
        info: new TextEncoder().encode(RELAY_HKDF_INFO),
      },
      hkdfKey,
      SESSION_KEY_BYTES * 2 * 8,
    ),
  );
  const importAesKey = (bytes: Uint8Array<ArrayBuffer>, usage: KeyUsage[]) => subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usage);
  return {
    clientToHost: await importAesKey(keyMaterial.slice(0, SESSION_KEY_BYTES), ['encrypt', 'decrypt']),
    hostToClient: await importAesKey(keyMaterial.slice(SESSION_KEY_BYTES), ['encrypt', 'decrypt']),
  };
};

const writeCounter = (target: Uint8Array, offset: number, counter: bigint) => {
  for (let i = IV_COUNTER_BYTES - 1; i >= 0; i -= 1) {
    target[offset + i] = Number(counter & 0xffn);
    counter >>= 8n;
  }
};

const readCounter = (source: Uint8Array, offset: number) => {
  let value = 0n;
  for (let i = 0; i < IV_COUNTER_BYTES; i += 1) {
    const byte = source[offset + i];
    if (byte === undefined) throw new RelayCryptoError('encrypted frame too short');
    value = (value << 8n) | BigInt(byte);
  }
  return value;
};

export const createFrameEncryptor = (key: CryptoKey) => {
  const ivPrefix = new Uint8Array(IV_PREFIX_BYTES);
  globalThis.crypto.getRandomValues(ivPrefix);
  let counter = 0n;
  return {
    async encrypt(plaintext: Uint8Array<ArrayBuffer>) {
      if (plaintext.length > MAX_PLAINTEXT_FRAME_BYTES) {
        throw new RelayCryptoError('plaintext frame exceeds maximum size');
      }
      counter += 1n;
      const iv = new Uint8Array(ENCRYPTED_FRAME_IV_BYTES);
      iv.set(ivPrefix, 0);
      writeCounter(iv, IV_PREFIX_BYTES, counter);
      const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
      const frame = new Uint8Array(ENCRYPTED_FRAME_HEADER_BYTES + ciphertext.length);
      frame[0] = ENCRYPTED_FRAME_VERSION;
      frame.set(iv, 1);
      frame.set(ciphertext, ENCRYPTED_FRAME_HEADER_BYTES);
      return frame;
    },
  };
};

export const createFrameDecryptor = (key: CryptoKey) => {
  let lastCounter = 0n;
  return {
    async decrypt(frame: Uint8Array<ArrayBuffer>) {
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
      if (counter !== lastCounter + 1n) {
        throw new RelayCryptoError('frame counter gap');
      }
      let plaintext;
      try {
        plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, key, frame.slice(ENCRYPTED_FRAME_HEADER_BYTES));
      } catch {
        throw new RelayCryptoError('frame decryption failed');
      }
      lastCounter = counter;
      return new Uint8Array(plaintext);
    },
  };
};

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export const bytesToBase64Url = (bytes: Uint8Array) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    if (b0 === undefined) throw new RelayCryptoError('missing base64url byte');
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
};

export const base64UrlToBytes = (value: string) => {
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


interface HandshakeEnvelope { v?: unknown; t?: unknown; batch?: unknown; flowControl?: unknown; nonce?: unknown; clientPubJwk?: unknown }
const isHandshakeEnvelope = (value: unknown): value is HandshakeEnvelope => typeof value === 'object' && value !== null;
interface HelloMessage { t: 'hello'; v: number; clientPubJwk: HandshakeJwk; nonce: string; batch: boolean; flowControl: boolean }
interface ReadyMessage { t: 'ready'; v: number; batch: boolean; flowControl: boolean }
interface ReadyPayload { t: 'ready'; v: number; batch?: boolean; flowControl?: boolean }
const parseHandshakeMessage = (raw: string): HelloMessage | ReadyMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isHandshakeEnvelope(parsed)) return null;
  if (parsed.v !== RELAY_PROTOCOL_VERSION) return null;
  const batch = parsed.batch === true;
  const flowControl = parsed.flowControl === true;
  if (parsed.t === 'ready') {
    return { t: 'ready', v: RELAY_PROTOCOL_VERSION, batch, flowControl };
  }
  if (parsed.t === 'hello' && isHelloPayload(parsed)) {
    return { t: 'hello', v: RELAY_PROTOCOL_VERSION, clientPubJwk: parsed.clientPubJwk, nonce: parsed.nonce, batch, flowControl };
  }
  return null;
};

const isHelloPayload = (value: HandshakeEnvelope): value is HandshakeEnvelope & { nonce: string; clientPubJwk: HandshakeJwk } =>
  typeof value.nonce === 'string' && isHandshakeJwk(value.clientPubJwk);

export interface RelayChannel {
  encryptor: ReturnType<typeof createFrameEncryptor>;
  decryptor: ReturnType<typeof createFrameDecryptor>;
}
type HandshakeAction = { type: 'fail'; closeCode: number; reason: string }
  | { type: 'ignore' }
  | { type: 'send-text'; text: string }
  | { type: 'established'; batch: boolean; flowControl: boolean; replyText: string; channel: RelayChannel };
export interface RelayCapabilities { batch?: boolean; flowControl?: boolean | undefined }

const failClosed = (reason: string): HandshakeAction => ({
  type: 'fail',
  closeCode: RelayCloseCode.ChannelFailure,
  reason,
});

export const createHostHandshake = (hostEncPrivateKey: CryptoKey, options: RelayCapabilities = {}) => {
  const localBatch = options.batch !== false;
  let established = false;
  let acceptedClientKeyFingerprint: string | null = null;
  let readyText: string | null = null;
  let negotiatedBatch = false;
  return {
    get established() {
      return established;
    },
    async handleText(raw: string): Promise<HandshakeAction> {
      const message = parseHandshakeMessage(raw);
      if (message?.t !== 'hello') {
        if (established) {
          return failClosed('plaintext frame on established channel');
        }
        return { type: 'ignore' };
      }
      const fingerprint = publicKeyJwkFingerprint(message.clientPubJwk);
      if (acceptedClientKeyFingerprint !== null) {
        if (fingerprint === acceptedClientKeyFingerprint && readyText !== null) {
          return { type: 'send-text', text: readyText };
        }
        return { type: 'fail', closeCode: RelayCloseCode.RekeyMismatch, reason: 'rekey mismatch' };
      }
      let clientPublicKey;
      let nonce;
      try {
        clientPublicKey = await importEcdhPublicKey(message.clientPubJwk);
        nonce = base64UrlToBytes(message.nonce);
      } catch {
        return failClosed('malformed hello');
      }
      let keys;
      try {
        keys = await deriveSessionKeys(hostEncPrivateKey, clientPublicKey, nonce);
      } catch {
        return failClosed('key derivation failed');
      }
      acceptedClientKeyFingerprint = fingerprint;
      negotiatedBatch = localBatch && message.batch === true;
      const flowControl = options.flowControl !== false && message.flowControl === true;
      const ready: ReadyPayload = { t: 'ready', v: RELAY_PROTOCOL_VERSION };
      if (negotiatedBatch) ready.batch = true;
      if (flowControl) ready.flowControl = true;
      readyText = JSON.stringify(ready);
      established = true;
      return {
        type: 'established',
        batch: negotiatedBatch,
        flowControl,
        replyText: readyText,
        channel: {
          encryptor: createFrameEncryptor(keys.hostToClient),
          decryptor: createFrameDecryptor(keys.clientToHost),
        },
      };
    },
  };
};
