
const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export const DOCUMENT_AAD = 'openchamber-share-v1 document';
export const ANSWER_AAD = 'openchamber-share-v1 answer';
const AUTH_INFO = 'openchamber-share-v1 auth';
const ENC_INFO = 'openchamber-share-v1 enc';
const BLOB_VERSION = 1;
const IV_LENGTH = 12;
const LINK_KEY_LENGTH = 32;
export const SEAL_OVERHEAD_BYTES = 1 + IV_LENGTH + 16;

export const toBase64Url = (bytes) => Buffer.from(bytes).toString('base64url');
export const fromBase64Url = (text) => new Uint8Array(Buffer.from(text, 'base64url'));

export const generateLinkKey = () => globalThis.crypto.getRandomValues(new Uint8Array(LINK_KEY_LENGTH));

export const generatePin = () => {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    const [value] = globalThis.crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) return String(value % 1_000_000).padStart(6, '0');
  }
};

export const deriveShareKeys = async (linkKey, pin) => {
  const base = await subtle.importKey('raw', linkKey, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = encoder.encode(pin);
  const authBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(AUTH_INFO) }, base, 256);
  const encKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(ENC_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const auth = new Uint8Array(authBits);
  return { auth, encKey, authHash: toBase64Url(new Uint8Array(await subtle.digest('SHA-256', auth))) };
};

export const deriveShareSecrets = async (linkKey, pin) => {
  const base = await subtle.importKey('raw', linkKey, 'HKDF', false, ['deriveBits']);
  const salt = encoder.encode(pin);
  const bits = (info) => subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) }, base, 256);
  return { auth: new Uint8Array(await bits(AUTH_INFO)), enc: new Uint8Array(await bits(ENC_INFO)) };
};

export const importEncKey = (enc) => subtle.importKey('raw', enc, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

export const sealJson = async (encKey, value, aad) => {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cipher = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    encKey,
    encoder.encode(JSON.stringify(value)),
  ));
  const blob = new Uint8Array(1 + IV_LENGTH + cipher.length);
  blob[0] = BLOB_VERSION;
  blob.set(iv, 1);
  blob.set(cipher, 1 + IV_LENGTH);
  return blob;
};

export const openJson = async (encKey, blob, aad) => {
  if (blob.length < SEAL_OVERHEAD_BYTES || blob[0] !== BLOB_VERSION) throw new Error('Unknown share blob format');
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: blob.slice(1, 1 + IV_LENGTH), additionalData: encoder.encode(aad) },
    encKey,
    blob.slice(1 + IV_LENGTH),
  );
  return JSON.parse(new TextDecoder().decode(plain));
};
