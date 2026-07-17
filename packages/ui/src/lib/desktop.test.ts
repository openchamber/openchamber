import { afterEach, describe, expect, test } from 'bun:test';
import { isDesktopTrustedLocalPage } from './desktop';

const originalWindow = globalThis.window;

const setDesktopWindow = (options: { pageOrigin: string; localOrigin: string; apiBaseUrl: string }): void => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: options.pageOrigin },
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_LOCAL_ORIGIN__: options.localOrigin,
      __OPENCHAMBER_API_BASE_URL__: options.apiBaseUrl,
    },
  });
};

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('isDesktopTrustedLocalPage', () => {
  test('allows the local Electron page while a remote runtime is active', () => {
    setDesktopWindow({
      pageOrigin: 'http://127.0.0.1:57123',
      localOrigin: 'http://127.0.0.1:57123',
      apiBaseUrl: 'https://remote.example',
    });

    expect(isDesktopTrustedLocalPage()).toBe(true);
  });

  test('allows the local Electron page while the local runtime is active', () => {
    setDesktopWindow({
      pageOrigin: 'http://127.0.0.1:57123',
      localOrigin: 'http://127.0.0.1:57123',
      apiBaseUrl: 'http://127.0.0.1:57123',
    });

    expect(isDesktopTrustedLocalPage()).toBe(true);
  });

  test('allows the packaged Electron page independently of the configured local origin', () => {
    setDesktopWindow({
      pageOrigin: 'openchamber-ui://app',
      localOrigin: 'http://127.0.0.1:57123',
      apiBaseUrl: 'https://remote.example',
    });

    expect(isDesktopTrustedLocalPage()).toBe(true);
  });

  test('rejects a same-port loopback alias that is not the configured local origin', () => {
    setDesktopWindow({
      pageOrigin: 'http://localhost:57123',
      localOrigin: 'http://127.0.0.1:57123',
      apiBaseUrl: 'https://remote.example',
    });

    expect(isDesktopTrustedLocalPage()).toBe(false);
  });

  test('rejects a remote page even when it runs in an Electron shell', () => {
    setDesktopWindow({
      pageOrigin: 'https://remote.example',
      localOrigin: 'http://127.0.0.1:57123',
      apiBaseUrl: 'https://remote.example',
    });

    expect(isDesktopTrustedLocalPage()).toBe(false);
  });

  for (const pageOrigin of ['null', '']) {
    test(`rejects the untrusted ${JSON.stringify(pageOrigin)} page origin`, () => {
      setDesktopWindow({
        pageOrigin,
        localOrigin: 'http://127.0.0.1:57123',
        apiBaseUrl: 'https://remote.example',
      });

      expect(isDesktopTrustedLocalPage()).toBe(false);
    });
  }
});
