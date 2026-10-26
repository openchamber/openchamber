import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openPushContent, parsePushKey, sealPushContent } from './push-seal.js';

describe('push seal', () => {
  it('round-trips and never repeats a nonce', () => {
    const key = crypto.randomBytes(32).toString('base64');
    const first = sealPushContent(key, { title: 'Done', body: 'Session name' });
    const second = sealPushContent(key, { title: 'Done', body: 'Session name' });
    expect(first).not.toBe(second);
    expect(first.startsWith('v1.')).toBe(true);
    expect(openPushContent(key, first)).toEqual({ title: 'Done', body: 'Session name' });
  });

  it('matches the combined layout the phones read: nonce, ciphertext, 16-byte tag', () => {
    const key = crypto.randomBytes(32);
    const sealed = sealPushContent(key.toString('base64'), { title: 't', body: 'b' });
    const combined = Buffer.from(sealed.slice(3), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, combined.subarray(0, 12));
    decipher.setAuthTag(combined.subarray(combined.length - 16));
    const plain = Buffer.concat([decipher.update(combined.subarray(12, combined.length - 16)), decipher.final()]);
    expect(JSON.parse(plain.toString('utf8'))).toEqual({ title: 't', body: 'b' });
  });

  it('accepts only a 32-byte base64 key', () => {
    expect(parsePushKey(crypto.randomBytes(32).toString('base64'))).not.toBeNull();
    expect(parsePushKey(crypto.randomBytes(16).toString('base64'))).toBeNull();
    expect(parsePushKey('not a key')).toBeNull();
    expect(parsePushKey(undefined)).toBeNull();
  });
});
