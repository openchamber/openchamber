import crypto from 'node:crypto';
import fsReal from 'node:fs/promises';
import os from 'node:os';
import pathReal from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApnsRuntime } from './apns-runtime.js';
import { openPushContent } from './push-seal.js';
import { deriveServerId } from '../relay/signing-key.js';

// A real P-256 key so the ES256 signing path (direct mode) runs for real.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS_CONFIG = { keyId: 'KEY123', teamId: 'TEAM123', p8: P8, bundleId: 'com.openchamber.app', environment: 'sandbox' };

// In-memory fs so add-then-read reflects within a test.
const createMemoryFs = () => {
  let content = null;
  const files = new Map();
  return {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => {
      if (content == null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    }),
    writeFile: vi.fn(async (target, data) => {
      files.set(target, data);
      content = data;
    }),
    rename: vi.fn(async (from, to) => {
      if (files.has(from)) {
        files.set(to, files.get(from));
        files.delete(from);
        content = files.get(to);
      }
    }),
    rm: vi.fn(async (target) => {
      files.delete(target);
    }),
    unlink: vi.fn(async (target) => {
      files.delete(target);
    }),
  };
};

// In-memory relay key store: the auto-generated signing keypair persists and
// reads back; `generations` counts how many keypairs were minted.
const makeMemoryKeyStore = () => {
  const slots = {};
  const store = {
    generations: 0,
    getOrCreate: async (slot, generate) => {
      if (!slots[slot]) {
        store.generations += 1;
        slots[slot] = await generate();
      }
      return slots[slot];
    },
    generation: () => 0,
  };
  return store;
};

const makeDeps = (overrides = {}) => {
  const settings = {};
  return {
    fsPromises: createMemoryFs(),
    path: { dirname: () => '/tmp' },
    crypto,
    http2: { connect: vi.fn(() => { throw new Error('http2 must not be used in relay mode'); }) },
    APNS_TOKENS_FILE_PATH: '/tmp/apns-tokens.json',
    readSettingsFromDiskMigrated: vi.fn(async () => settings),
    relayKeyStore: makeMemoryKeyStore(),
    ...overrides,
  };
};

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Mirror of the relay's verifier (crypto.subtle), to prove the server's signatures are valid.
const verifyRelaySignature = async (publicKeyJwk, message, sigB64Url) => {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: publicKeyJwk.kty, crv: publicKeyJwk.crv, x: publicKeyJwk.x, y: publicKeyJwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new Uint8Array(Buffer.from(sigB64Url, 'base64url')),
    new TextEncoder().encode(message),
  );
};

const isRegister = ([url]) => String(url).endsWith('/register-token');
const isSend = ([url]) => String(url) === 'https://relay.test/v1/push/send';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCHAMBER_PUSH_RELAY_URL;
  delete process.env.OPENCHAMBER_PUSH_RELAY_DISABLED;
  delete process.env.OPENCHAMBER_APNS_ENVIRONMENT;
});

describe('apns runtime relay mode (default)', () => {
  it('removing a token unbinds it on the relay once no session on this server holds it, and never sends a token it did not hold', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const isUnregister = ([url]) => String(url) === 'https://relay.test/v1/push/unregister-token';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.addOrUpdateApnsToken('s2', 'tokenA');

    await runtime.removeApnsToken('s1', 'tokenA');
    expect(fetchMock.mock.calls.filter(isUnregister)).toHaveLength(0);

    await runtime.removeApnsToken('never-registered', 'tokenA');
    await runtime.removeApnsToken('s1', 'tokenNeverHeld');
    expect(fetchMock.mock.calls.filter(isUnregister)).toHaveLength(0);

    await runtime.removeApnsToken('s2', 'tokenA');
    const unregisterCalls = fetchMock.mock.calls.filter(isUnregister);
    expect(unregisterCalls).toHaveLength(1);
    const body = JSON.parse(unregisterCalls[0][1].body);
    expect(body.token).toBe('tokenA');
    expect(await verifyRelaySignature(body.publicKeyJwk, `unregister.${body.ts}.tokenA`, body.sig)).toBe(true);
  });

  it('registers tokens (signed) and posts signed generic text, dropping dead tokens', async () => {
    const fetchMock = vi.fn(async (url) =>
      isRegister([url])
        ? jsonResponse({ ok: true })
        : jsonResponse({
            results: [
              { token: 'tokenA', ok: true, drop: false },
              { token: 'tokenDead', ok: false, drop: true },
            ],
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.addOrUpdateApnsToken('s2', 'tokenDead');

    // Each new token is bound on the relay with a signed register-token call.
    const registerCalls = fetchMock.mock.calls.filter(isRegister);
    expect(registerCalls).toHaveLength(2);
    for (const [url, init] of registerCalls) {
      expect(url).toBe('https://relay.test/v1/push/register-token');
      const body = JSON.parse(init.body);
      expect(body.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
      expect(typeof body.ts).toBe('number');
      expect(body.platform).toBe('ios');
      expect(await verifyRelaySignature(body.publicKeyJwk, `${body.ts}.${body.token}.${body.platform}`, body.sig)).toBe(true);
    }

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions(
      { title: 'Agent response is ready', body: 'My session', badge: 3, tag: 'ready-x', data: { sessionId: 'sess1' } },
      {},
    );

    const sendCall = fetchMock.mock.calls.find(isSend);
    expect(sendCall).toBeTruthy();
    const sent = JSON.parse(sendCall[1].body);
    expect(sendCall[1].headers.authorization).toBeUndefined();
    expect(new Set(sent.tokens)).toEqual(new Set(['tokenA', 'tokenDead']));
    expect(sent.title).toBe('Agent response is ready');
    expect(sent.body).toBe('My session');
    expect(sent.badge).toBe(3);
    expect(sent.env).toBe('production');
    expect(sent.data).toMatchObject({ sessionId: 'sess1' });
    expect(sent.data.serverId).toBe(deriveServerId({ crypto }, sent.publicKeyJwk));
    expect(sent.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    const sendMessage = `${sent.ts}.${[...sent.tokens].sort().join(',')}.${sent.title}`;
    expect(await verifyRelaySignature(sent.publicKeyJwk, sendMessage, sent.sig)).toBe(true);

    // tokenDead should have been dropped → next send targets only tokenA.
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 'x', body: 'y', tag: 't' }, {});
    expect(JSON.parse(fetchMock.mock.calls.find(isSend)[1].body).tokens).toEqual(['tokenA']);
  });

  it('truncates a non-ASCII collapse-id by UTF-8 bytes, not characters, in the relay body', async () => {
    const fetchMock = vi.fn(async (url) =>
      isRegister([url]) ? jsonResponse({ ok: true }) : jsonResponse({ results: [{ token: 'tokenA', ok: true, drop: false }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');

    // 64 euro signs: 64 chars but 192 UTF-8 bytes — APNs rejects the header
    // (BadCollapseId) when the collapse-id is sliced by characters.
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: '\u20ac'.repeat(64) }, {});
    let sent = JSON.parse(fetchMock.mock.calls.find(isSend)[1].body);
    expect(sent.collapseId).toBe('\u20ac'.repeat(21));
    expect(Buffer.byteLength(sent.collapseId, 'utf8')).toBeLessThanOrEqual(64);

    // A cut inside a surrogate pair must not leave a lone surrogate behind.
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: `${'a'.repeat(63)}\u{1f600}` }, {});
    sent = JSON.parse(fetchMock.mock.calls.find(isSend)[1].body);
    expect(sent.collapseId).toBe('a'.repeat(63));

    // ASCII control: byte-identical to the old character slice.
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' }, {});
    sent = JSON.parse(fetchMock.mock.calls.find(isSend)[1].body);
    expect(sent.collapseId).toBe('ready-x');
  });

  it('reuses one persisted keypair (same serverId) across register + send', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const deps = makeDeps();
    const runtime = createApnsRuntime(deps);
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'x' }, {});

    const keys = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).publicKeyJwk);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys.every((k) => k.x === keys[0].x && k.y === keys[0].y)).toBe(true);
    // Keypair was generated + persisted exactly once.
    expect(deps.relayKeyStore.generations).toBe(1);
  });

  it('honors an explicit sandbox environment override for every token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    process.env.OPENCHAMBER_APNS_ENVIRONMENT = 'sandbox';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA', undefined, 'ios', 'production');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });

    const sent = JSON.parse(fetchMock.mock.calls.find(isSend)[1].body);
    expect(sent.env).toBe('sandbox');
  });

  it('routes each token to its registered environment (dev build sandbox, release production)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenXcode', undefined, 'ios', 'sandbox');
    await runtime.addOrUpdateApnsToken('s2', 'tokenStore', undefined, 'ios', 'production');
    await runtime.addOrUpdateApnsToken('s3', 'tokenLegacy'); // no environment → production

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });

    const sends = fetchMock.mock.calls.filter(isSend).map(([, init]) => JSON.parse(init.body));
    expect(sends).toHaveLength(2);
    const byEnv = Object.fromEntries(sends.map((s) => [s.env, new Set(s.tokens)]));
    expect(byEnv.sandbox).toEqual(new Set(['tokenXcode']));
    expect(byEnv.production).toEqual(new Set(['tokenStore', 'tokenLegacy']));
  });

  it('seals the text for a device that gave a key, and only for that device', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const pushKey = crypto.randomBytes(32).toString('base64');

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenSealed', undefined, 'ios', 'production', pushKey);
    await runtime.addOrUpdateApnsToken('s2', 'tokenPlain', undefined, 'ios', 'production');

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 'Agent response is ready', body: 'Fix the login bug', data: { sessionId: 'ses_1' } });

    const sends = fetchMock.mock.calls.filter(isSend).map(([, init]) => JSON.parse(init.body));
    const sealed = sends.find((send) => send.tokens.includes('tokenSealed'));
    const plain = sends.find((send) => send.tokens.includes('tokenPlain'));
    // The relay sees no session name for the sealed device...
    expect(sealed.tokens).toEqual(['tokenSealed']);
    expect(sealed.body).toBe('');
    expect(JSON.stringify(sealed)).not.toContain('Fix the login bug');
    expect(sealed.data.sessionId).toBe('ses_1');
    // ...and the phone opens it with its key.
    expect(openPushContent(pushKey, sealed.data.enc)).toEqual({ title: 'Agent response is ready', body: 'Fix the login bug' });
    // An app without a key keeps getting the text as before.
    expect(plain.body).toBe('Fix the login bug');
    expect(plain.data.enc).toBeUndefined();
  });

  it('seals the richer phone text when one is given, and sends it nowhere else', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const pushKey = crypto.randomBytes(32).toString('base64');

    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenSealed', undefined, 'ios', 'production', pushKey);
    await runtime.addOrUpdateApnsToken('s2', 'tokenPlain', undefined, 'ios', 'production');

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({
      title: 'Agent response is ready',
      body: 'Fix the login bug',
      sealed: { title: 'Fix the login bug', body: 'Done, the redirect loop is gone' },
      data: { sessionId: 'ses_1' },
    });

    const sends = fetchMock.mock.calls.filter(isSend).map(([, init]) => JSON.parse(init.body));
    const sealed = sends.find((send) => send.tokens.includes('tokenSealed'));
    const plain = sends.find((send) => send.tokens.includes('tokenPlain'));
    expect(openPushContent(pushKey, sealed.data.enc)).toEqual({ title: 'Fix the login bug', body: 'Done, the redirect loop is gone' });
    expect(JSON.stringify(sends)).not.toContain('redirect loop');
    expect(plain).toMatchObject({ title: 'Agent response is ready', body: 'Fix the login bug' });
  });

  it('sends every token past 100 in chunks and acts on drop results from later chunks (#1500)', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (isRegister([url])) return jsonResponse({ ok: true });
      const sentTokens = JSON.parse(init.body).tokens;
      // tok109 rides in the second chunk; the relay marks it dead there.
      return jsonResponse({
        results: sentTokens.includes('tok109') ? [{ token: 'tok109', ok: false, drop: true }] : [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';

    const runtime = createApnsRuntime(makeDeps());
    const allTokens = [];
    for (let session = 0; session < 11; session += 1) {
      for (let i = 0; i < 10; i += 1) {
        const token = `tok${session * 10 + i}`;
        allTokens.push(token);
        await runtime.addOrUpdateApnsToken(`s${session}`, token);
      }
    }

    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' }, {});

    const sends = fetchMock.mock.calls.filter(isSend).map(([, init]) => JSON.parse(init.body));
    expect(sends.map((send) => send.tokens.length)).toEqual([100, 10]);
    expect(new Set(sends.flatMap((send) => send.tokens))).toEqual(new Set(allTokens));
    for (const sent of sends) {
      const sendMessage = `${sent.ts}.${[...sent.tokens].sort().join(',')}.${sent.title}`;
      expect(await verifyRelaySignature(sent.publicKeyJwk, sendMessage, sent.sig)).toBe(true);
    }

    // The drop result from the second chunk removed tok109: the next send
    // targets the remaining 109 tokens and never includes it.
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' }, {});
    const resends = fetchMock.mock.calls.filter(isSend).map(([, init]) => JSON.parse(init.body));
    const resentTokens = resends.flatMap((send) => send.tokens);
    expect(resentTokens).toHaveLength(109);
    expect(resentTokens).not.toContain('tok109');
  });

  describe('when the relay cannot be reached', () => {
    const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('limits every relay request in time', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true, results: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const runtime = createApnsRuntime(makeDeps());
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');
      await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });

      expect(fetchMock.mock.calls).toHaveLength(2);
      for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('sends once more after a short delay when the request never left', async () => {
      const runtime = createApnsRuntime(makeDeps());
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(refused())
        .mockResolvedValueOnce(jsonResponse({ results: [] }));
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['setTimeout'] });

      const sending = runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await sending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    });

    it('does not send again when the relay may have the request', async () => {
      const runtime = createApnsRuntime(makeDeps());
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      for (const error of [timedOut(), Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })]) {
        const fetchMock = vi.fn().mockRejectedValue(error);
        vi.stubGlobal('fetch', fetchMock);
        await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
      expect(warn.mock.calls.map((call) => call.join(' '))).toEqual([
        '[APNs relay] request failed: no answer in 15 s, not retried',
        '[APNs relay] request failed: fetch failed (ECONNRESET)',
      ]);
    });

    it('logs once more and gives up when the retry fails too', async () => {
      const runtime = createApnsRuntime(makeDeps());
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');
      const fetchMock = vi.fn().mockRejectedValue(refused());
      vi.stubGlobal('fetch', fetchMock);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['setTimeout'] });

      const sending = runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
      await vi.advanceTimersByTimeAsync(5_000);
      await sending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map((call) => call.join(' '))).toEqual([
        '[APNs relay] unreachable (ECONNREFUSED), retrying in 5 s',
        '[APNs relay] request failed: fetch failed (ECONNREFUSED)',
      ]);
    });

    it('keeps an unchecked failure message and its includes receiver', async () => {
      const runtime = createApnsRuntime(makeDeps());
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const message = {
        includes: vi.fn(function (code) {
          expect(this).toBe(message);
          expect(code).toBe(7);
          return 'present';
        }),
      };
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue({ message, code: 7 }));
      await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
      expect(message.includes).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('[APNs relay] request failed:', message);
    });

    it('sends to other devices while one send waits for its retry', async () => {
      const runtime = createApnsRuntime(makeDeps());
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
      // Each device with a push key is its own send, in registration order.
      await runtime.addOrUpdateApnsToken('s1', 'tokenRefused', undefined, 'ios', 'production', crypto.randomBytes(32).toString('base64'));
      await runtime.addOrUpdateApnsToken('s2', 'tokenOther', undefined, 'android', 'production', crypto.randomBytes(32).toString('base64'));
      const fetchMock = vi.fn(async (_url, init) => {
        if (JSON.parse(init.body).tokens.includes('tokenRefused')) throw refused();
        return jsonResponse({ results: [] });
      });
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['setTimeout'] });

      const sending = runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
      await vi.advanceTimersByTimeAsync(0);
      const sentTo = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).tokens[0]);
      expect(new Set(sentTo)).toEqual(new Set(['tokenRefused', 'tokenOther']));
      await vi.advanceTimersByTimeAsync(5_000);
      await sending;
    });
  });

  it('no-ops (no relay call) when no tokens are registered', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createApnsRuntime(makeDeps());
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a relay body-read timeout instead of swallowing it as an empty result (#993)', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchMock = vi.fn(async (url, init) => {
        if (isRegister([url])) return jsonResponse({ ok: true });
        // Headers arrive, but the body only settles when the caller's
        // deadline signal aborts.
        // A real streamed body: it only settles when the caller's deadline
        // signal aborts, which errors the bounded reader's read.
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fetchMock);
      process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
      const runtime = createApnsRuntime(makeDeps());
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');

      const sending = runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'x' }, {});
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(sending).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith('[APNs relay] request failed:', 'aborted');
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the null fallback for a malformed relay body (no request-failed warning) (#993)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchMock = vi.fn(async (url) =>
        isRegister([url])
          ? jsonResponse({ ok: true })
          : new Response('<not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
      const runtime = createApnsRuntime(makeDeps());
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');

      await expect(runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'x' }, {})).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[APNs relay] request failed'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('drops no tokens for an over-cap relay body (null fallback, no request-failed warning) (#1304)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Valid JSON with a drop:true result, padded past the 1 MiB cap: the
      // bounded reader must refuse it while streaming, so the drop is
      // never acted on.
      const overCapBody = JSON.stringify({
        results: [{ token: 'tokenDead', ok: false, drop: true }],
        padding: 'x'.repeat(1024 * 1024),
      });
      let sendCount = 0;
      const fetchMock = vi.fn(async (url) => {
        if (isRegister([url])) return jsonResponse({ ok: true });
        sendCount += 1;
        return sendCount === 1
          ? new Response(overCapBody, { status: 200, headers: { 'content-type': 'application/json' } })
          : jsonResponse({ results: [] });
      });
      vi.stubGlobal('fetch', fetchMock);
      process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
      const runtime = createApnsRuntime(makeDeps());
      await runtime.addOrUpdateApnsToken('s1', 'tokenDead');

      await expect(runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'x' }, {})).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('[APNs relay] request failed'));

      // tokenDead was NOT dropped: the next send still targets it.
      fetchMock.mockClear();
      await runtime.sendApnsToAllUiSessions({ title: 't2', body: 'b2', tag: 'y' }, {});
      expect(JSON.parse(fetchMock.mock.calls.find(isSend)[1].body).tokens).toEqual(['tokenDead']);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('apns runtime direct fallback (relay disabled)', () => {
  it('leaves direct APNs environment unset without an explicit override (per-token routing)', async () => {
    const { environment: _environment, ...configWithoutEnvironment } = APNS_CONFIG;
    const runtime = createApnsRuntime(
      makeDeps({ readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: configWithoutEnvironment })) }),
    );

    await expect(runtime.resolveApnsConfig()).resolves.toMatchObject({ environment: null });
  });

  it('sends each token to the APNs host of its registered environment', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const { environment: _environment, ...configWithoutEnvironment } = APNS_CONFIG;
    const hosts = [];
    const http2 = {
      connect: (host) => {
        const targeted = [];
        hosts.push({ host, targeted });
        return {
          on: () => {},
          close: () => {},
          request: (headers) => {
            targeted.push(String(headers[':path']).replace('/3/device/', ''));
            const listeners = {};
            const req = {
              on: (event, cb) => { listeners[event] = cb; return req; },
              setEncoding: () => req,
              end: () => {
                queueMicrotask(() => {
                  listeners.response?.({ ':status': '200' });
                  listeners.end?.();
                });
              },
            };
            return req;
          },
        };
      },
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: configWithoutEnvironment })) }),
    );
    await runtime.addOrUpdateApnsToken('s1', 'tokenXcode', undefined, 'ios', 'sandbox');
    await runtime.addOrUpdateApnsToken('s2', 'tokenStore', undefined, 'ios', 'production');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });

    const byHost = Object.fromEntries(hosts.map(({ host, targeted }) => [host, targeted]));
    expect(byHost['https://api.sandbox.push.apple.com']).toEqual(['tokenXcode']);
    expect(byHost['https://api.push.apple.com']).toEqual(['tokenStore']);
  });

  it('truncates a non-ASCII collapse-id by UTF-8 bytes, not characters, in the direct header', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const seenHeaders = [];
    const http2 = {
      connect: () => ({
        on: () => {},
        close: () => {},
        request: (headers) => {
          seenHeaders.push(headers);
          const listeners = {};
          const req = {
            on: (event, cb) => { listeners[event] = cb; return req; },
            setEncoding: () => req,
            end: () => {
              queueMicrotask(() => {
                listeners.response?.({ ':status': '200' });
                listeners.end?.();
              });
            },
          };
          return req;
        },
      }),
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateApnsToken('s', 'tokenDirect');

    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: '\u20ac'.repeat(64) });
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]['apns-collapse-id']).toBe('\u20ac'.repeat(21));
    expect(Buffer.byteLength(seenHeaders[0]['apns-collapse-id'], 'utf8')).toBeLessThanOrEqual(64);

    seenHeaders.length = 0;
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: `${'a'.repeat(63)}\u{1f600}` });
    expect(seenHeaders[0]['apns-collapse-id']).toBe('a'.repeat(63));
  });

  it('signApnsJwt produces a 3-part ES256 token with the expected header/claims', () => {
    const runtime = createApnsRuntime(makeDeps());
    const parts = runtime.signApnsJwt(APNS_CONFIG).split('.');
    expect(parts).toHaveLength(3);
    expect(JSON.parse(Buffer.from(parts[0], 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(Buffer.from(parts[1], 'base64url').toString()).iss).toBe('TEAM123');
  });
});

describe('apns token persistence', () => {
  it('saves the next token after a write fails on a full disk', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const fsPromises = createMemoryFs();
    fsPromises.writeFile.mockImplementationOnce(async () => {
      const error = new Error('ENOSPC: no space left on device, write');
      error.code = 'ENOSPC';
      throw error;
    });
    const runtime = createApnsRuntime(makeDeps({ fsPromises }));

    await expect(runtime.addOrUpdateApnsToken('s1', 'tokenA')).rejects.toThrow('ENOSPC');
    await expect(runtime.addOrUpdateApnsToken('s1', 'tokenB')).resolves.toBeUndefined();

    const stored = JSON.parse(await fsPromises.readFile());
    expect(Object.values(stored.tokensBySession).flat().map((entry) => entry.deviceToken)).toEqual(['tokenB']);
  });
});

describe('clearing handled notifications from the phones', () => {
  const isClear = ([url]) => String(url) === 'https://relay.test/v1/push/clear';

  it('asks the relay to clear the tags on every device, sealed or not, signed over the tags', async () => {
    const fetchMock = vi.fn(async (url) =>
      isRegister([url]) ? jsonResponse({ ok: true }) : jsonResponse({ results: [{ token: 'tokenGone', ok: false, drop: true }] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenPlain');
    await runtime.addOrUpdateApnsToken('s2', 'tokenSealed', undefined, 'android', undefined, crypto.randomBytes(32).toString('base64'));
    await runtime.addOrUpdateApnsToken('s3', 'tokenGone');

    fetchMock.mockClear();
    await runtime.clearApnsNotifications({ tags: ['ready-ses_1', 'question-ses_1'], badge: 2 });

    const clearCalls = fetchMock.mock.calls.filter(isClear);
    expect(clearCalls).toHaveLength(1);
    const sent = JSON.parse(clearCalls[0][1].body);
    expect(new Set(sent.tokens)).toEqual(new Set(['tokenPlain', 'tokenSealed', 'tokenGone']));
    expect(sent).toMatchObject({ tags: ['ready-ses_1', 'question-ses_1'], badge: 2, env: 'production' });
    expect(sent.title).toBeUndefined();
    const message = `${sent.ts}.${[...sent.tokens].sort().join(',')}.clear.${sent.tags.join(',')}`;
    expect(await verifyRelaySignature(sent.publicKeyJwk, message, sent.sig)).toBe(true);

    // A token the relay reports dead is dropped, as on a send.
    fetchMock.mockClear();
    await runtime.clearApnsNotifications({ tags: ['ready-ses_2'] });
    expect(new Set(JSON.parse(fetchMock.mock.calls.find(isClear)[1].body).tokens)).toEqual(new Set(['tokenPlain', 'tokenSealed']));
  });

  it('says once that a relay without the route cannot clear, and sends nothing visible instead', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async (url) => (isRegister([url]) ? jsonResponse({ ok: true }) : new Response('not found', { status: 404 })));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');

    await runtime.clearApnsNotifications({ tags: ['ready-ses_1'] });
    await runtime.clearApnsNotifications({ tags: ['ready-ses_2'] });

    expect(fetchMock.mock.calls.filter(isSend)).toHaveLength(0);
    expect(warn.mock.calls.filter(([line]) => String(line).includes('cannot clear'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('clears more tags than the relay accepts per request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
    const runtime = createApnsRuntime(makeDeps());
    await runtime.addOrUpdateApnsToken('s1', 'tokenA');
    const tags = Array.from({ length: 21 }, (_, index) => `question-ses_${index}@${index + 1}`);

    await runtime.clearApnsNotifications({ tags, badge: 1 });

    const requests = fetchMock.mock.calls.filter(isClear).map(([, init]) => JSON.parse(init.body));
    expect(requests.map((request) => request.tags.length)).toEqual([20, 1]);
    expect(requests.flatMap((request) => request.tags)).toEqual(tags);
    expect(requests.map((request) => request.badge)).toEqual([1, 1]);
  });

  it('sends a background push without an alert in direct mode', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const requests = [];
    const http2 = {
      connect: () => ({
        on: () => {},
        close: () => {},
        request: (headers) => {
          const listeners = {};
          const request = { headers, body: '' };
          requests.push(request);
          const req = {
            on: (event, cb) => { listeners[event] = cb; return req; },
            setEncoding: () => req,
            end: (body) => {
              request.body = body;
              queueMicrotask(() => {
                listeners.response?.({ ':status': '200' });
                listeners.end?.();
              });
            },
          };
          return req;
        },
      }),
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateApnsToken('s', 'tokenDirect');
    await runtime.clearApnsNotifications({ tags: ['ready-ses_1'], badge: 0 });

    expect(requests).toHaveLength(1);
    expect(requests[0].headers).toMatchObject({ 'apns-push-type': 'background', 'apns-priority': '5' });
    expect(requests[0].headers['apns-collapse-id']).toBeUndefined();
    expect(JSON.parse(requests[0].body)).toEqual({ aps: { 'content-available': 1 }, clear: 'ready-ses_1', badge: 0 });
  });
});

describe('apns runtime deadlines (#798)', () => {
  // A wedged peer: accepts the request and never answers, but like a real
  // fetch it rejects when the caller's signal aborts.
  const stalledFetch = (signals) =>
    vi.fn(async (url, init) => {
      signals.push(init?.signal ?? null);
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });

  it('settles token registration when the relay register fetch never answers', async () => {
    vi.useFakeTimers();
    try {
      const signals = [];
      vi.stubGlobal('fetch', stalledFetch(signals));
      process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
      const runtime = createApnsRuntime(makeDeps());

      const registration = runtime.addOrUpdateApnsToken('s1', 'tokenStalled');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(registration).resolves.toBeUndefined();

      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles the fanout when the relay send fetch never answers', async () => {
    vi.useFakeTimers();
    try {
      const signals = [];
      const fetchMock = vi.fn(async (url, init) => {
        if (isRegister([url])) return jsonResponse({ ok: true });
        signals.push(init?.signal ?? null);
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      process.env.OPENCHAMBER_PUSH_RELAY_URL = 'https://relay.test/v1/push/send';
      const runtime = createApnsRuntime(makeDeps());
      await runtime.addOrUpdateApnsToken('s1', 'tokenA');

      const sending = runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'x' }, {});
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(sending).resolves.toBeUndefined();

      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys a stalled direct APNs request at its deadline and settles the send', async () => {
    vi.useFakeTimers();
    try {
      process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
      const destroyedWith = [];
      const close = vi.fn();
      const http2 = {
        connect: () => ({
          on: () => {},
          close,
          request: () => {
            const listeners = {};
            const req = {
              on: (event, cb) => { listeners[event] = cb; return req; },
              setEncoding: () => req,
              end: () => {},
              destroy: (error) => {
                destroyedWith.push(error);
                queueMicrotask(() => listeners.error?.(error));
              },
            };
            return req;
          },
        }),
      };
      const runtime = createApnsRuntime(
        makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
      );
      await runtime.addOrUpdateApnsToken('s', 'tokenDirect');

      const sending = runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(sending).resolves.toBeUndefined();

      expect(destroyedWith).toHaveLength(1);
      expect(destroyedWith[0].message).toContain('APNs request timed out');
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a direct APNs send when APNs closes the stream without end or error (#992)', async () => {
    vi.useFakeTimers();
    try {
      process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
      const close = vi.fn();
      const destroyCalls = [];
      const http2 = {
        connect: () => ({
          on: () => {},
          close,
          request: () => {
            const listeners = {};
            const req = {
              on: (event, cb) => { listeners[event] = cb; return req; },
              setEncoding: () => req,
              // APNs cancels the stream (RST_STREAM): it closes with neither
              // 'end' nor 'error', like a real http2 stream.
              end: () => { queueMicrotask(() => listeners.close?.()); },
              // On an already-closed stream destroy() is a no-op: it emits
              // nothing, so the 30s deadline cannot settle this send either.
              destroy: (error) => { destroyCalls.push(error); },
            };
            return req;
          },
        }),
      };
      const runtime = createApnsRuntime(
        makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
      );
      await runtime.addOrUpdateApnsToken('s', 'tokenDirect');

      const sending = runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'cancel-x' });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(sending).resolves.toBeUndefined();

      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a direct APNs response body at the cap and never acts on an over-cap reason', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const targeted = [];
    const destroyedWith = [];
    let requestCount = 0;
    const http2 = {
      connect: () => ({
        on: () => {},
        close: () => {},
        request: (headers) => {
          requestCount += 1;
          const thisRequest = requestCount;
          targeted.push(String(headers[':path']).replace('/3/device/', ''));
          const listeners = {};
          const req = {
            on: (event, cb) => { listeners[event] = cb; return req; },
            setEncoding: () => req,
            destroy: (error) => {
              destroyedWith.push(error);
              queueMicrotask(() => listeners.error?.(error));
            },
            end: () => {
              queueMicrotask(() => {
                if (thisRequest === 1) {
                  listeners.response?.({ ':status': '400' });
                  // Valid JSON if buffered whole (trailing spaces are JSON
                  // whitespace) whose reason would remove the token — but
                  // the body is over the 1 MiB cap, so it must not be acted on.
                  listeners.data?.('{"reason":"BadDeviceToken"}' + ' '.repeat(1024 * 1024));
                } else {
                  listeners.response?.({ ':status': '200' });
                  listeners.end?.();
                }
              });
            },
          };
          return req;
        },
      }),
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateApnsToken('s', 'tokenDirect');

    await expect(runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'cap-x' })).resolves.toBeUndefined();
    expect(destroyedWith).toHaveLength(1);
    expect(destroyedWith[0].message).toContain('exceeded');

    // The token survived: a second send still targets it.
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'cap-y' });
    expect(targeted).toEqual(['tokenDirect', 'tokenDirect']);
  });

  it('settles an over-cap direct APNs body through end when destroy emits no error', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const targeted = [];
      let requestCount = 0;
      const http2 = {
        connect: () => ({
          on: () => {},
          close: () => {},
          request: (headers) => {
            requestCount += 1;
            const thisRequest = requestCount;
            targeted.push(String(headers[':path']).replace('/3/device/', ''));
            const listeners = {};
            const req = {
              on: (event, cb) => { listeners[event] = cb; return req; },
              setEncoding: () => req,
              // Destroy is a no-op here (already-closing stream): settlement
              // must come from the end handler's overflow branch instead.
              destroy: () => {},
              end: () => {
                queueMicrotask(() => {
                  if (thisRequest === 1) {
                    listeners.response?.({ ':status': '400' });
                    listeners.data?.('{"reason":"BadDeviceToken"}');
                    listeners.data?.(' '.repeat(1024 * 1024));
                    listeners.end?.();
                  } else {
                    listeners.response?.({ ':status': '200' });
                    listeners.end?.();
                  }
                });
              },
            };
            return req;
          },
        }),
      };
      const runtime = createApnsRuntime(
        makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
      );
      await runtime.addOrUpdateApnsToken('s', 'tokenDirect');

      await expect(runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'cap-end-x' })).resolves.toBeUndefined();
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('response body exceeded');

      // The over-cap BadDeviceToken reason was never acted on.
      await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'cap-end-y' });
      expect(targeted).toEqual(['tokenDirect', 'tokenDirect']);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('apns runtime store durability', () => {
  const temporaryDirectories = [];

  const makeRealRuntime = async (filePath, fsOverrides = {}) => createApnsRuntime(makeDeps({
    fsPromises: { ...fsReal, ...fsOverrides },
    path: pathReal,
    APNS_TOKENS_FILE_PATH: filePath,
  }));

  const makeTempStore = async () => {
    const dir = await fsReal.mkdtemp(pathReal.join(os.tmpdir(), 'openchamber-apns-store-'));
    temporaryDirectories.push(dir);
    return { dir, filePath: pathReal.join(dir, 'apns-tokens.json') };
  };

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => fsReal.rm(dir, { recursive: true, force: true })));
  });

  it('preserves a corrupt tokens file before a later write overwrites it', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { dir, filePath } = await makeTempStore();
      const corrupt = '{"version":1,"tokensBySession":{"s1":[{"deviceToken":"tok';
      await fsReal.writeFile(filePath, corrupt, 'utf8');
      const runtime = await makeRealRuntime(filePath);

      await runtime.addOrUpdateApnsToken('session-1', 'tokenA');

      const preserved = (await fsReal.readdir(dir)).filter((name) => name.includes('.corrupt-'));
      expect(preserved).toHaveLength(1);
      expect(await fsReal.readFile(pathReal.join(dir, preserved[0]), 'utf8')).toBe(corrupt);
      const warnText = warnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(warnText).toContain(preserved[0]);
      const stored = JSON.parse(await fsReal.readFile(filePath, 'utf8'));
      expect(stored.version).toBe(1);
      expect(Object.values(stored.tokensBySession).flat().map((entry) => entry.deviceToken)).toEqual(['tokenA']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('preserves a wrong-version tokens file before a later write overwrites it', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { dir, filePath } = await makeTempStore();
      const wrongVersion = JSON.stringify({ version: 2, tokensBySession: {} });
      await fsReal.writeFile(filePath, wrongVersion, 'utf8');
      const runtime = await makeRealRuntime(filePath);

      await runtime.addOrUpdateApnsToken('session-1', 'tokenA');

      const preserved = (await fsReal.readdir(dir)).filter((name) => name.includes('.corrupt-'));
      expect(preserved).toHaveLength(1);
      expect(await fsReal.readFile(pathReal.join(dir, preserved[0]), 'utf8')).toBe(wrongVersion);
      const stored = JSON.parse(await fsReal.readFile(filePath, 'utf8'));
      expect(stored.version).toBe(1);
      expect(Object.values(stored.tokensBySession).flat().map((entry) => entry.deviceToken)).toEqual(['tokenA']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not preserve an empty tokens file; a later write just replaces it', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const { dir, filePath } = await makeTempStore();
    await fsReal.writeFile(filePath, '', 'utf8');
    const runtime = await makeRealRuntime(filePath);

    await runtime.addOrUpdateApnsToken('session-1', 'tokenA');

    expect((await fsReal.readdir(dir)).filter((name) => name.includes('.corrupt-'))).toHaveLength(0);
    const stored = JSON.parse(await fsReal.readFile(filePath, 'utf8'));
    expect(Object.values(stored.tokensBySession).flat().map((entry) => entry.deviceToken)).toEqual(['tokenA']);
  });

  it('keeps the persist queue usable after a preservation failure', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { filePath } = await makeTempStore();
      let failCorruptRename = true;
      const runtime = await makeRealRuntime(filePath, {
        rename: async (from, to) => {
          if (failCorruptRename && String(to).includes('.corrupt-')) throw new Error('rename failed');
          return fsReal.rename(from, to);
        },
      });
      await fsReal.writeFile(filePath, '{"version":1,"tokensBySession":{"s1":[', 'utf8');

      await expect(runtime.addOrUpdateApnsToken('session-1', 'tokenA')).rejects.toThrow('Failed to preserve');

      await fsReal.writeFile(filePath, JSON.stringify({ version: 1, tokensBySession: {} }), 'utf8');
      failCorruptRename = false;
      await runtime.addOrUpdateApnsToken('session-2', 'tokenB');

      const stored = JSON.parse(await fsReal.readFile(filePath, 'utf8'));
      expect(Object.values(stored.tokensBySession).flat().map((entry) => entry.deviceToken)).toEqual(['tokenB']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('writes via a temp file renamed into place, never directly to the tokens path', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const { dir, filePath } = await makeTempStore();
    const writeTargets = [];
    const renameCalls = [];
    const runtime = await makeRealRuntime(filePath, {
      writeFile: async (target, ...rest) => {
        writeTargets.push(String(target));
        return fsReal.writeFile(target, ...rest);
      },
      rename: async (from, to) => {
        renameCalls.push([String(from), String(to)]);
        return fsReal.rename(from, to);
      },
    });

    await runtime.addOrUpdateApnsToken('session-1', 'tokenA');

    expect(writeTargets.length).toBeGreaterThan(0);
    expect(writeTargets).not.toContain(filePath);
    expect(writeTargets.every((target) => target.startsWith(`${filePath}.tmp-`))).toBe(true);
    expect(renameCalls).toEqual(writeTargets.map((target) => [target, filePath]));
    expect(await fsReal.readdir(dir)).toEqual(['apns-tokens.json']);
  });

  it('leaves the previous valid tokens file intact and no temp behind when the rename fails', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const { dir, filePath } = await makeTempStore();
    const runtime = await makeRealRuntime(filePath);
    await runtime.addOrUpdateApnsToken('session-1', 'tokenA');
    const before = await fsReal.readFile(filePath, 'utf8');

    const failing = await makeRealRuntime(filePath, {
      rename: async () => {
        throw new Error('rename failed');
      },
    });
    await expect(failing.addOrUpdateApnsToken('session-2', 'tokenB')).rejects.toThrow('rename failed');
    expect(await fsReal.readFile(filePath, 'utf8')).toBe(before);
    expect(await fsReal.readdir(dir)).toEqual(['apns-tokens.json']);
  });
});

describe('APNs .p8 key file bounded read (#1777)', () => {
  const ENV_KEYS = ['OPENCHAMBER_APNS_KEY_ID', 'OPENCHAMBER_APNS_TEAM_ID', 'OPENCHAMBER_APNS_P8', 'OPENCHAMBER_APNS_P8_PATH'];
  let dir;
  let savedEnv;

  beforeEach(async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-apns-p8-'));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.OPENCHAMBER_APNS_KEY_ID = 'KID1234567';
    process.env.OPENCHAMBER_APNS_TEAM_ID = 'TEAM123456';
    delete process.env.OPENCHAMBER_APNS_P8;
  });

  afterEach(async () => {
    const fs = await import('node:fs/promises');
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const runtimeWithRealFs = async () => {
    const fsPromises = (await import('node:fs/promises')).default;
    const path = (await import('node:path')).default;
    return createApnsRuntime(makeDeps({ fsPromises, path }));
  };

  it('reads a real small .p8 unchanged', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const keyPath = path.join(dir, 'AuthKey.p8');
    const pem = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----';
    await fs.writeFile(keyPath, `${pem}\n`);
    process.env.OPENCHAMBER_APNS_P8_PATH = keyPath;
    const config = await (await runtimeWithRealFs()).resolveApnsConfig();
    expect(config?.p8).toBe(pem);
  });

  it('refuses an oversized file into the unconfigured path instead of buffering it whole', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const keyPath = path.join(dir, 'big.p8');
    await fs.writeFile(keyPath, 'A'.repeat(1024 * 1024));
    process.env.OPENCHAMBER_APNS_P8_PATH = keyPath;
    const config = await (await runtimeWithRealFs()).resolveApnsConfig();
    expect(config).toBeNull();
  });

  it('refuses a FIFO promptly instead of hanging the send path', async () => {
    const { execFileSync } = await import('node:child_process');
    const path = await import('node:path');
    const keyPath = path.join(dir, 'fifo.p8');
    execFileSync('mkfifo', [keyPath]);
    process.env.OPENCHAMBER_APNS_P8_PATH = keyPath;
    const config = await (await runtimeWithRealFs()).resolveApnsConfig();
    expect(config).toBeNull();
  });
});
