import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createApnsRuntime } from './apns-runtime.js';

// A real P-256 key so the ES256 signing path runs for real (no mocking crypto).
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

// http2 mock that records targeted device tokens and replies with `status`.
const createMockHttp2 = (targeted, status = 200) => ({
  connect: () => ({
    on: () => {},
    close: () => {},
    request: (headers) => {
      const token = String(headers[':path'] || '').replace('/3/device/', '');
      targeted.push(token);
      const listeners = {};
      const req = {
        on: (event, cb) => {
          listeners[event] = cb;
          return req;
        },
        setEncoding: () => req,
        end: () => {
          queueMicrotask(() => {
            listeners.response?.({ ':status': String(status) });
            if (status !== 200) listeners.data?.(JSON.stringify({ reason: 'BadDeviceToken' }));
            listeners.end?.();
          });
        },
      };
      return req;
    },
  }),
});

const makeDeps = (overrides = {}) => ({
  fsPromises: createMemoryFs(),
  path: { dirname: () => '/tmp' },
  crypto,
  http2: { connect: vi.fn(() => { throw new Error('http2.connect should not be called'); }) },
  APNS_TOKENS_FILE_PATH: '/tmp/apns-tokens.json',
  readSettingsFromDiskMigrated: vi.fn(async () => ({})),
  isAnyUiVisible: () => false,
  ...overrides,
});

// Deps with APNs configured (via settings) + a recording http2 mock.
const makeConfiguredDeps = (targeted, { status = 200, fsPromises, isAnyUiVisible } = {}) =>
  makeDeps({
    fsPromises: fsPromises ?? createMemoryFs(),
    readSettingsFromDiskMigrated: vi.fn(async () => ({ apnsConfig: APNS_CONFIG })),
    http2: createMockHttp2(targeted, status),
    ...(isAnyUiVisible ? { isAnyUiVisible } : {}),
  });

describe('apns runtime token store', () => {
  it('adds, dedups, and removes device tokens per session', async () => {
    const targeted = [];
    const runtime = createApnsRuntime(makeConfiguredDeps(targeted));

    await runtime.addOrUpdateApnsToken('session-a', 'tokenA', 'iPhone');
    await runtime.addOrUpdateApnsToken('session-a', 'tokenA', 'iPhone'); // dedup
    await runtime.addOrUpdateApnsToken('session-a', 'tokenB');

    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });
    expect(new Set(targeted)).toEqual(new Set(['tokenA', 'tokenB']));

    targeted.length = 0;
    await runtime.removeApnsToken('session-a', 'tokenA');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });
    expect(targeted).toEqual(['tokenB']);
  });
});

describe('apns runtime JWT', () => {
  it('produces a 3-part ES256 token with the expected header/claims', () => {
    const runtime = createApnsRuntime(makeDeps());
    const jwt = runtime.signApnsJwt(APNS_CONFIG);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(header).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(claims.iss).toBe('TEAM123');
    expect(typeof claims.iat).toBe('number');
  });
});

describe('apns runtime send gating', () => {
  it('no-ops (never opens a connection) when APNs is unconfigured', async () => {
    const deps = makeDeps();
    const runtime = createApnsRuntime(deps);
    await runtime.addOrUpdateApnsToken('s', 'tokenZ');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' }, { requireNoSse: true });
    expect(deps.http2.connect).not.toHaveBeenCalled();
  });

  it('suppresses when a UI client is focused (requireNoSse)', async () => {
    const targeted = [];
    const runtime = createApnsRuntime(makeConfiguredDeps(targeted, { isAnyUiVisible: () => true }));
    await runtime.addOrUpdateApnsToken('s', 'tokenF');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b' }, { requireNoSse: true });
    expect(targeted).toEqual([]);
  });

  it('drops a token on a 410 response', async () => {
    const targeted = [];
    const fs = createMemoryFs();
    const runtime = createApnsRuntime(makeConfiguredDeps(targeted, { status: 410, fsPromises: fs }));
    await runtime.addOrUpdateApnsToken('s', 'tokenDead');
    await runtime.sendApnsToAllUiSessions({ title: 't', body: 'b', tag: 'ready-x' });
    expect(targeted).toEqual(['tokenDead']);
    const stored = JSON.parse(await fs.readFile());
    expect(stored.tokensBySession).toEqual({});
  });
});
