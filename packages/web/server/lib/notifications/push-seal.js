import crypto from 'node:crypto';

/**
 * End-to-end encryption of native push text. The phone makes a 256-bit key
 * and hands it to its own server when it registers for push (that request
 * travels the app's own channel, not the push relay). The server seals the
 * notification's title and body with it; the relay, Apple and Google carry
 * only the sealed text and a generic title. The phone's notification
 * extension (iOS) or messaging service (Android) opens it.
 *
 * Wire format of `enc`: `v1.` + base64(nonce[12] || ciphertext || tag[16]),
 * AES-256-GCM. This is CryptoKit's `AES.GCM.SealedBox.combined` and what
 * `javax.crypto` "AES/GCM/NoPadding" reads after the nonce.
 */
const SEAL_VERSION = 'v1.';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/** A push key as the phone sends it: base64 of exactly 32 bytes, else null. */
const PUSH_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export const parsePushKey = (value) => {
  const text = String(value ?? '').trim();
  if (!PUSH_KEY_PATTERN.test(text)) return null;
  return Buffer.from(text, 'base64').length === KEY_BYTES ? text : null;
};

/** Seal `{ title, body }` for one device. */
export const sealPushContent = (pushKey, content) => {
  const key = Buffer.from(pushKey, 'base64');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(JSON.stringify({ title: content.title ?? '', body: content.body ?? '' }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${SEAL_VERSION}${Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')}`;
};

/** The inverse, for tests and for anyone checking the format. */
export const openPushContent = (pushKey, sealed) => {
  if (!sealed.startsWith(SEAL_VERSION)) throw new Error('Unknown push seal version');
  const combined = Buffer.from(sealed.slice(SEAL_VERSION.length), 'base64');
  const nonce = combined.subarray(0, NONCE_BYTES);
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(NONCE_BYTES, combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(pushKey, 'base64'), nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
};
