import { afterEach, describe, expect, test } from 'bun:test';

import { getClientPlatform, isCapacitorApp, isHarmonyApp, isNativeMobileApp } from './platform';

const originalWindow = globalThis.window;

const installWindow = (value: object) => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
};

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('native mobile platform detection', () => {
  test('identifies Harmony without claiming Capacitor', () => {
    installWindow({
      location: { protocol: 'https:' },
      openChamberHarmony: {
        getPlatform: () => 'harmony',
        getCapabilities: () => JSON.stringify({ secureStorage: true }),
        secureStorageGet: async () => JSON.stringify({ ok: true, value: null }),
        secureStorageSet: async () => JSON.stringify({ ok: true }),
        secureStorageRemove: async () => JSON.stringify({ ok: true }),
      },
    });

    expect(isHarmonyApp()).toBe(true);
    expect(isNativeMobileApp()).toBe(true);
    expect(isCapacitorApp()).toBe(false);
    expect(getClientPlatform()).toBe('harmony');
  });

  test('unknown bridges retain web semantics', () => {
    installWindow({
      location: { protocol: 'https:' },
      openChamberHarmony: { getPlatform: () => 'unknown', getCapabilities: () => '{}' },
    });

    expect(isHarmonyApp()).toBe(false);
    expect(isNativeMobileApp()).toBe(false);
    expect(getClientPlatform()).toBe('web');
  });
});
