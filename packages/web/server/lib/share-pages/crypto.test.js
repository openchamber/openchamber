import { describe, expect, it } from 'vitest';

import {
  ANSWER_AAD,
  DOCUMENT_AAD,
  deriveShareKeys,
  generateLinkKey,
  generatePin,
  openJson,
  sealJson,
  toBase64Url,
} from './crypto.js';

// The browser side, written the way the relay's own test and viewer write it
// (openchamber-website apps/relay/scripts/share.test.ts), with nothing shared
// with crypto.js, so a drift on either side fails here.
const enc = new TextEncoder();
const viewerKeys = async (linkKey, pin) => {
  const base = await crypto.subtle.importKey('raw', linkKey, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = enc.encode(pin);
  const auth = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('openchamber-share-v1 auth') }, base, 256);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('openchamber-share-v1 enc') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { auth: b64(auth), authHash: b64(await crypto.subtle.digest('SHA-256', auth)), key };
};
const viewerSeal = async (key, value, aad) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(13 + cipher.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(cipher, 13);
  return out;
};
const viewerUnseal = async (key, bytes, aad) => JSON.parse(new TextDecoder().decode(
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(1, 13), additionalData: enc.encode(aad) }, key, bytes.slice(13)),
));

describe('share crypto', () => {
  it('derives the same auth and auth hash the viewer derives', async () => {
    const linkKey = generateLinkKey();
    const ours = await deriveShareKeys(linkKey, '482913');
    const theirs = await viewerKeys(linkKey, '482913');
    expect(toBase64Url(ours.auth)).toBe(theirs.auth);
    expect(ours.authHash).toBe(theirs.authHash);
    expect(ours.authHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('seals a document the viewer opens, and opens an answer the viewer sealed', async () => {
    const linkKey = generateLinkKey();
    const ours = await deriveShareKeys(linkKey, '000731');
    const theirs = await viewerKeys(linkKey, '000731');
    const document = { v: 1, title: 'Schema', html: '<p>Pick one — ✓</p>' };
    expect(await viewerUnseal(theirs.key, await sealJson(ours.encKey, document, DOCUMENT_AAD), DOCUMENT_AAD)).toEqual(document);

    const answer = { v: 1, data: { pick: 'B' }, summary: 'Picked B', submittedAt: 1 };
    expect(await openJson(ours.encKey, await viewerSeal(theirs.key, answer, ANSWER_AAD), ANSWER_AAD)).toEqual(answer);
  });

  it('refuses a blob sealed for the other purpose or with another PIN', async () => {
    const linkKey = generateLinkKey();
    const ours = await deriveShareKeys(linkKey, '111111');
    const blob = await sealJson(ours.encKey, { v: 1 }, DOCUMENT_AAD);
    await expect(openJson(ours.encKey, blob, ANSWER_AAD)).rejects.toThrow();
    const other = await deriveShareKeys(linkKey, '111112');
    await expect(openJson(other.encKey, blob, DOCUMENT_AAD)).rejects.toThrow();
  });

  it('makes six-digit PINs', () => {
    for (let index = 0; index < 200; index += 1) expect(generatePin()).toMatch(/^\d{6}$/);
  });
});
