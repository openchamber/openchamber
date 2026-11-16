import crypto from 'node:crypto';

const SEAL_VERSION = 'v1.';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

const PUSH_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export const parsePushKey = (value) => {
  const text = String(value ?? '').trim();
  if (!PUSH_KEY_PATTERN.test(text)) return null;
  return Buffer.from(text, 'base64').length === KEY_BYTES ? text : null;
};

export const sealPushContent = (pushKey, content) => {
  const key = Buffer.from(pushKey, 'base64');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(JSON.stringify({ title: content.title ?? '', body: content.body ?? '' }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${SEAL_VERSION}${Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')}`;
};

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
