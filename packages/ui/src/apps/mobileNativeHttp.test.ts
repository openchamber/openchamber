import { expect, test } from 'bun:test';
import type { HttpOptions } from '@capacitor/core';
import { serveTestHttp } from '@/lib/test-http-server';

test('native connection checks disable redirects and keep the browser fallback closed', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalCapacitor = Object.getOwnPropertyDescriptor(globalThis, 'Capacitor');
  let targetRequests = 0;
  let failNative = false;
  const target = await serveTestHttp((_request, response) => {
    targetRequests += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ authenticated: true }));
  });
  const source = await serveTestHttp((_request, response) => {
    response.writeHead(302, { Location: target.url.toString() });
    response.end();
  });
  Object.defineProperty(globalThis, 'Capacitor', { configurable: true, writable: true, value: {
    PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] }],
    nativePromise: async (_plugin: string, _method: string, options: HttpOptions) => {
      if (failNative) throw new Error('Native transport unavailable');
      const response = await fetch(options.url, {
        headers: options.headers, redirect: options.disableRedirects ? 'manual' : 'follow',
      });
      return { status: response.status, data: await response.text(), headers: {}, url: response.url };
    },
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    Capacitor: { isNativePlatform: () => true }, location: { protocol: 'capacitor:' },
    setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } });
  try {
    const { validateMobileConnectionSession } = await import('./mobileConnections');
    const url = source.url.toString().replace(/\/$/, '');
    const input = { url, requestHeaders: { url, values: { 'X-Proxy-Secret': 'synthetic-only' } } };
    expect(await validateMobileConnectionSession(input)).toBe(false);
    expect(targetRequests).toBe(0);
    failNative = true;
    expect(await validateMobileConnectionSession(input)).toBe(false);
    expect(targetRequests).toBe(0);
    failNative = false;
    expect(await validateMobileConnectionSession({ url })).toBe(true);
    expect(targetRequests).toBe(2);
  } finally {
    source.close();
    target.close();
    for (const [name, descriptor] of [['window', originalWindow], ['Capacitor', originalCapacitor]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
