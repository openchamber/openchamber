import { afterAll, beforeEach, expect, test } from 'bun:test';

// Exercise the real Capacitor plugin proxy against an in-memory native bridge.
// This file runs in its own process, like the rest of the UI test suite.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalCapacitor = Object.getOwnPropertyDescriptor(globalThis, 'Capacitor');
const secrets = new Map<string, string>();
const metadata = new Map<string, string>();
let failRead = false;
let failWrite = false;
let failMetadata = false;
Object.defineProperty(globalThis, 'Capacitor', {
  configurable: true,
  writable: true,
  value: {
    PluginHeaders: [{ name: 'SecureStorage', methods: ['internalGetItem', 'internalSetItem', 'internalRemoveItem'].map((name) => ({ name, rtype: 'promise' })) }],
    nativePromise: async (_plugin: string, method: string, options: { prefixedKey: string; data?: string }) => {
      if (method === 'internalGetItem') {
        if (failRead) throw new Error('Keychain locked');
        return { data: secrets.get(options.prefixedKey) ?? null };
      }
      if (method === 'internalSetItem') {
        if (failWrite) throw new Error('Keychain unavailable');
        secrets.set(options.prefixedKey, options.data ?? '');
        return;
      }
      secrets.delete(options.prefixedKey);
      return { success: true };
    },
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true },
    location: { protocol: 'capacitor:' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    localStorage: {
      getItem: (key: string) => metadata.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failMetadata) throw new Error('Storage unavailable');
        metadata.set(key, value);
      },
      removeItem: (key: string) => metadata.delete(key),
    },
  }),
});
const { upsertMobileConnection, loadMobileConnections, loadMobileConnectionHeaders, autoConnectLastInstance } = await import('./mobileConnections');

beforeEach(() => {
  secrets.clear();
  metadata.clear();
  failRead = false;
  failWrite = false;
  failMetadata = false;
});
afterAll(() => {
  for (const [name, descriptor] of [['window', originalWindow], ['Capacitor', originalCapacitor]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const url = 'https://protected.example';
const values = { 'CF-Access-Client-Secret': 'test-proxy-secret' };
const connection: Parameters<typeof upsertMobileConnection>[0] = {
  label: 'Protected', candidates: [{ kind: 'direct', url }], requestHeaders: { url, values },
};

test('native header values stay out of metadata and survive reload, edit and removal', async () => {
  const saved = await upsertMobileConnection(connection);
  expect([...metadata.values()].join('')).not.toContain('test-proxy-secret');
  expect((await loadMobileConnections())[0].requestHeaders).toBeUndefined();
  expect(await loadMobileConnectionHeaders(saved[0].id)).toEqual({ url, values });
  expect(secrets.size).toBe(1);

  await upsertMobileConnection({ ...connection, id: saved[0].id, requestHeaders: { url, values: { 'X-Proxy': 'replacement' } } });
  expect(secrets.size).toBe(1);
  expect(await loadMobileConnectionHeaders(saved[0].id)).toEqual({ url, values: { 'X-Proxy': 'replacement' } });
  await upsertMobileConnection({ ...connection, id: saved[0].id, requestHeaders: null });
  expect(await loadMobileConnectionHeaders(saved[0].id)).toBeUndefined();
  expect(secrets.size).toBe(0);
});

test('failed secret and metadata writes preserve the previous saved headers', async () => {
  const saved = await upsertMobileConnection(connection);
  const edit = { ...connection, id: saved[0].id, requestHeaders: { url, values: { 'X-Proxy': 'replacement' } } };
  failWrite = true;
  await expect(upsertMobileConnection(edit)).rejects.toThrow('Mobile header storage unavailable');
  failWrite = false;
  expect(await loadMobileConnectionHeaders(saved[0].id)).toEqual({ url, values });
  failMetadata = true;
  await expect(upsertMobileConnection(edit)).rejects.toThrow('Mobile header storage unavailable');
  failMetadata = false;
  expect(await loadMobileConnectionHeaders(saved[0].id)).toEqual({ url, values });
  expect(secrets.size).toBe(1);
});

test('unavailable or malformed secure headers cannot become an empty successful read', async () => {
  const saved = await upsertMobileConnection(connection);
  failRead = true;
  await expect(loadMobileConnectionHeaders(saved[0].id)).rejects.toThrow();
  expect(await autoConnectLastInstance()).toEqual({ status: 'unreachable', label: 'Protected' });
  failRead = false;
  for (const key of secrets.keys()) secrets.set(key, '{"url":7,"values":[]}');
  await expect(loadMobileConnectionHeaders(saved[0].id)).rejects.toThrow();
  expect((await loadMobileConnections())[0].requestHeadersKey).toBe(saved[0].requestHeadersKey);
  for (const key of secrets.keys()) secrets.set(key, JSON.stringify({ url, values: { 'invalid header': 'value' } }));
  await expect(loadMobileConnectionHeaders(saved[0].id)).rejects.toThrow();
  expect(await autoConnectLastInstance()).toEqual({ status: 'unreachable', label: 'Protected' });
});
