import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApnsRuntime } from './apns-runtime.js';
import { openPushContent } from './push-seal.js';

// A real P-256 key so the ES256 signing path (direct mode) runs for real.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS_CONFIG = { keyId: 'KEY123', teamId: 'TEAM123', p8: P8, bundleId: 'com.openchamber.app', environment: 'sandbox' };

// In-memory fs so add-then-read reflects within a test.
const createMemoryFs = () => {
  let content = null;
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
    writeFile: vi.fn(async (_path, data) => {
      content = data;
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
    expect(sent.data).toEqual({ sessionId: 'sess1' });
    expect(sent.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    const sendMessage = `${sent.ts}.${[...sent.tokens].sort().join(',')}.${sent.title}`;
    expect(await verifyRelaySignature(sent.publicKeyJwk, sendMessage, sent.sig)).toBe(true);

    // tokenDead should have been dropped → next send targets only tokenA.
    fetchMock.mockClear();
    await runtime.sendApnsToAllUiSessions({ title: 'x', body: 'y', tag: 't' }, {});
    expect(JSON.parse(fetchMock.mock.calls.find(isSend)[1].body).tokens).toEqual(['tokenA']);
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

  it('signs an ES256 JWT and sends over http2 when relay is disabled', async () => {
    process.env.OPENCHAMBER_PUSH_RELAY_DISABLED = 'true';
    const targeted = [];
    const http2 = {
      connect: () => ({
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
      }),
    };
    const runtime = createApnsRuntime(
      makeDeps({ http2, readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })) }),
    );
    await runtime.addOrUpdateApnsToken('s', 'tokenDirect');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });
    expect(targeted).toEqual(['tokenDirect']);
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
