import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRelayShareSigner,
  createShareRelayClient,
  isRelayBaseAllowed,
  isSharingAvailable,
  relayHttpBase,
  resolveShareRelayBase,
} from './relay-client.js';

const saved = { mode: process.env.OPENCHAMBER_ENTERPRISE_MODE, relay: process.env.OPENCHAMBER_RELAY_URL };
afterEach(() => {
  process.env.OPENCHAMBER_ENTERPRISE_MODE = saved.mode ?? '';
  process.env.OPENCHAMBER_RELAY_URL = saved.relay ?? '';
});

const memoryKeyStore = () => {
  const entries = new Map();
  return {
    generation: () => 0,
    getOrCreate: async (name, create) => {
      if (!entries.has(name)) entries.set(name, await create());
      return entries.get(name);
    },
  };
};

// The relay's check (apps/relay/src/share/routes.ts verifyHost), in WebCrypto.
const relayVerifies = async (request) => {
  const headers = request.headers;
  const jwk = JSON.parse(Buffer.from(headers['x-openchamber-pk'], 'base64url').toString('utf8'));
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const serverId = Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).toString('base64url');
  const bodyHash = Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', request.body)).toString('base64url');
  const payload = `${headers['x-openchamber-ts']}.share.${serverId}.POST.${request.url.pathname}.${bodyHash}.${headers['x-openchamber-share'] ?? ''}`;
  const key = await crypto.webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(headers['x-openchamber-sig'], 'base64url'), new TextEncoder().encode(payload));
};

describe('share relay client', () => {
  it('signs every call the way the relay verifies it', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push({ url, ...init });
      return new Response(JSON.stringify({ id: 'x', url: 'u', states: [] }), { status: 200 });
    });
    const client = createShareRelayClient({ getSigner: createRelayShareSigner({ crypto, relayKeyStore: memoryKeyStore() }), fetchImpl });

    await client.create('https://relay.test', new Uint8Array([1, 2, 3]), { kind: 'page', wantsAnswer: false, expiresAt: 5, authHash: 'h' });
    await client.states('https://relay.test', ['a', 'b']);
    await client.close('https://relay.test/prefix', 'a');

    expect(requests.map(({ url }) => url.toString())).toEqual(['https://relay.test/p', 'https://relay.test/p/states', 'https://relay.test/prefix/p/a/close']);
    expect(JSON.parse(Buffer.from(requests[0].headers['x-openchamber-share'], 'base64url').toString())).toEqual({ kind: 'page', wantsAnswer: false, expiresAt: 5, authHash: 'h' });
    for (const request of requests) expect(await relayVerifies(request)).toBe(true);
  });

  it('batches state reads by the relay limit of 50', async () => {
    const fetchImpl = vi.fn(async (_url, init) => new Response(JSON.stringify({ states: JSON.parse(init.body).ids.map((id) => ({ id, status: 'open' })) })));
    const client = createShareRelayClient({ getSigner: createRelayShareSigner({ crypto, relayKeyStore: memoryKeyStore() }), fetchImpl });
    const states = await client.states('https://relay.test', Array.from({ length: 120 }, (_, index) => `s${index}`));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(states).toHaveLength(120);
  });

  it('carries the relay status on a refusal', async () => {
    const client = createShareRelayClient({
      getSigner: createRelayShareSigner({ crypto, relayKeyStore: memoryKeyStore() }),
      fetchImpl: async () => new Response('Share too large', { status: 413 }),
    });
    await expect(client.close('https://relay.test', 'a')).rejects.toMatchObject({ status: 413 });
  });
});

describe('where shares go', () => {
  it('derives the HTTP origin from the relay WebSocket address', () => {
    expect(relayHttpBase('wss://relay.openchamber.dev/ws')).toBe('https://relay.openchamber.dev');
    expect(relayHttpBase('ws://localhost:8788/ws')).toBe('http://localhost:8788');
    expect(relayHttpBase('wss://acme.test/relay/ws')).toBe('https://acme.test/relay');
  });

  it('uses the pinned relay, else the setting, else ours', () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '';
    process.env.OPENCHAMBER_RELAY_URL = '';
    expect(resolveShareRelayBase(null)).toBe('https://relay.openchamber.dev');
    expect(resolveShareRelayBase({ privateRelay: { relayUrl: 'wss://mine.test/ws' } })).toBe('https://mine.test');
    process.env.OPENCHAMBER_RELAY_URL = 'ws://localhost:8788/ws';
    expect(resolveShareRelayBase({ privateRelay: { relayUrl: 'wss://mine.test/ws' } })).toBe('http://localhost:8788');
  });

  it('in enterprise mode exists only with a pinned relay, and talks only to that one', () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '';
    process.env.OPENCHAMBER_RELAY_URL = '';
    expect(isSharingAvailable()).toBe(true);
    expect(isRelayBaseAllowed('https://relay.openchamber.dev')).toBe(true);

    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    expect(isSharingAvailable()).toBe(false);
    expect(isRelayBaseAllowed('https://relay.openchamber.dev')).toBe(false);

    process.env.OPENCHAMBER_RELAY_URL = 'wss://relay.acme.test/ws';
    expect(isSharingAvailable()).toBe(true);
    expect(isRelayBaseAllowed('https://relay.acme.test')).toBe(true);
    expect(isRelayBaseAllowed('https://relay.openchamber.dev')).toBe(false);
  });
});
