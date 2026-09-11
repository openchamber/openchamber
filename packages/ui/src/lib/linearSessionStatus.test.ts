import { afterEach, describe, expect, test } from 'bun:test';

import { resolveLinearSessionOrigin } from './linearSessionStatus';

describe('resolveLinearSessionOrigin', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  test('uses the page origin on web', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'https://app.example.com' },
      },
    });
    expect(resolveLinearSessionOrigin()).toBe('https://app.example.com');
  });

  test('uses the desktop loopback origin instead of the packaged UI scheme', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'openchamber-ui://app' },
        __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
        __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      },
    });
    expect(resolveLinearSessionOrigin()).toBe('http://127.0.0.1:3001');
  });

  test('reports no origin when the desktop shell has no http loopback', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'openchamber-ui://app' },
        __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
        __OPENCHAMBER_LOCAL_ORIGIN__: 'openchamber-ui://app',
      },
    });
    // A deep link is unopenable for everyone but this machine, so the server
    // gets no origin and posts no comment.
    expect(resolveLinearSessionOrigin()).toBe(undefined);
  });
});
