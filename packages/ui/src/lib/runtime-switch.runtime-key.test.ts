import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getRuntimeKey } from './runtime-switch';

/**
 * `getRuntimeKey` runs on store, event, and render paths, so its cost is
 * multiplied by everything the UI does. These tests pin both directions of the
 * derived-key cache: repeated calls with unchanged inputs must do no work, and
 * any change to the inputs it derives from must still be observed.
 *
 * This lives in its own file because the cache is only reachable while the
 * runtime endpoint has not been explicitly initialised, and module state is
 * shared across tests within a file.
 */

type RuntimeWindow = typeof globalThis & {
  __OPENCHAMBER_API_BASE_URL__?: string;
  __OPENCHAMBER_LOCAL_ORIGIN__?: string;
};

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const NativeURL = globalThis.URL;
let urlConstructions = 0;

const setRuntimeWindow = (apiBaseUrl: string | undefined, localOrigin: string | undefined): void => {
  const runtimeWindow = {} as RuntimeWindow;
  if (apiBaseUrl !== undefined) runtimeWindow.__OPENCHAMBER_API_BASE_URL__ = apiBaseUrl;
  if (localOrigin !== undefined) runtimeWindow.__OPENCHAMBER_LOCAL_ORIGIN__ = localOrigin;
  Object.defineProperty(globalThis, 'window', { value: runtimeWindow, configurable: true, writable: true });
};

beforeEach(() => {
  urlConstructions = 0;
  class CountingURL extends NativeURL {
    constructor(url: string | URL, base?: string | URL) {
      urlConstructions += 1;
      super(url, base);
    }
  }
  globalThis.URL = CountingURL as unknown as typeof URL;
});

afterEach(() => {
  globalThis.URL = NativeURL;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('getRuntimeKey caching', () => {
  test('resolves a same-origin endpoint to the local runtime key', () => {
    setRuntimeWindow('https://app.example.com/api', 'https://app.example.com');
    expect(getRuntimeKey()).toBe('local');
  });

  test('performs no URL work on repeated calls with unchanged inputs', () => {
    setRuntimeWindow('https://remote.example.com', 'https://app.example.com');
    const first = getRuntimeKey();
    expect(first).toBe('url:https://remote.example.com');

    urlConstructions = 0;
    for (let index = 0; index < 50; index += 1) expect(getRuntimeKey()).toBe(first);
    expect(urlConstructions).toBe(0);
  });

  test('recomputes when the injected API base URL changes at runtime', () => {
    setRuntimeWindow('https://first.example.com', 'https://app.example.com');
    expect(getRuntimeKey()).toBe('url:https://first.example.com');

    (globalThis as RuntimeWindow & { window: RuntimeWindow }).window.__OPENCHAMBER_API_BASE_URL__ = 'https://second.example.com';
    expect(getRuntimeKey()).toBe('url:https://second.example.com');
  });

  test('recomputes when the injected local origin changes at runtime', () => {
    setRuntimeWindow('https://app.example.com', 'https://other.example.com');
    expect(getRuntimeKey()).toBe('url:https://app.example.com');

    (globalThis as RuntimeWindow & { window: RuntimeWindow }).window.__OPENCHAMBER_LOCAL_ORIGIN__ = 'https://app.example.com';
    expect(getRuntimeKey()).toBe('local');
  });
});
