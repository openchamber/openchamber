import crypto from 'node:crypto';
import type { JsonValue } from './contracts.js';

const SEAL_VERSION = 'v1.';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

const PUSH_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export const parsePushKey = (value: JsonValue | undefined) => {
  const text = String(value ?? '').trim();
  if (!PUSH_KEY_PATTERN.test(text)) return null;
  return Buffer.from(text, 'base64').length === KEY_BYTES ? text : null;
};

export interface PushContent {
  title?: string | undefined;
  body?: string | undefined;
}

export const sealPushContent = (pushKey: string, content: PushContent) => {
  const key = Buffer.from(pushKey, 'base64');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(JSON.stringify({ title: content.title ?? '', body: content.body ?? '' }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${SEAL_VERSION}${Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')}`;
};

export const openPushContent = (pushKey: string, sealed: string) => {
  if (!sealed.startsWith(SEAL_VERSION)) throw new Error('Unknown push seal version');
  const combined = Buffer.from(sealed.slice(SEAL_VERSION.length), 'base64');
  const nonce = combined.subarray(0, NONCE_BYTES);
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(NONCE_BYTES, combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(pushKey, 'base64'), nonce);
  decipher.setAuthTag(tag);
  const content: JsonValue = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  return content;
};
