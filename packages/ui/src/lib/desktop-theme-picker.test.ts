import { expect, test } from 'bun:test';
import { createDesktopThemeFileAPI } from './desktop';

test('native theme picking follows the trusted preload capability rather than the active server', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const file = { name: 'night.jsonc', size: 2, text: '{}' };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_API_BASE_URL__: 'https://remote.example.test',
      __OPENCHAMBER_DESKTOP__: { pickThemeFile: async () => file },
    } });
    expect(await createDesktopThemeFileAPI()?.pick()).toEqual({ status: 'picked', file });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: { invoke: async () => null },
    } });
    expect(createDesktopThemeFileAPI()).toBeUndefined();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: { pickThemeFile: async () => ({ name: 'bad', size: -1 }) },
    } });
    await expect(createDesktopThemeFileAPI()?.pick()).rejects.toThrow();
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
