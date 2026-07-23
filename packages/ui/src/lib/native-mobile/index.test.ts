import { afterEach, describe, expect, test } from 'bun:test';

import { getNativeMobileAdapter, NativeMobileStorageError } from './index';

const originalWindow = globalThis.window;

const installWindow = (bridge?: object) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'https:' }, ...(bridge ? { openChamberHarmony: bridge } : {}) },
  });
};

const respondToHarmonyRequest = (requestId: string, result: object | string): void => {
  const receiver = (globalThis.window as typeof window & {
    __openChamberHarmonyBridgeResult?: (requestId: unknown, value: unknown) => void;
  }).__openChamberHarmonyBridgeResult;
  receiver?.(requestId, typeof result === 'string' ? result : JSON.stringify(result));
};

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('Harmony native mobile adapter', () => {
  test('rejects missing, malformed, and non-Harmony bridges', () => {
    installWindow();
    expect(getNativeMobileAdapter()).toBeNull();

    installWindow({ getPlatform: () => 'web', getCapabilities: () => '{}' });
    expect(getNativeMobileAdapter()).toBeNull();

    installWindow({ getPlatform: () => 'harmony', getCapabilities: () => '{' });
    expect(getNativeMobileAdapter()?.capabilities.secureStorage).toBe(false);
  });

  test('exposes only capabilities backed by all required bridge methods', () => {
    installWindow({
      getPlatform: () => 'harmony',
      getCapabilities: () => JSON.stringify({ secureStorage: true, nativeHttp: false }),
      secureStorageGet: () => undefined,
    });

    const adapter = getNativeMobileAdapter();
    expect(adapter?.platform).toBe('harmony');
    expect(adapter?.capabilities.secureStorage).toBe(false);
    expect(adapter?.secureStorage).toBe(undefined);
  });

  test('maps secure storage success, absence, and failure without exposing bridge details', async () => {
    const values = new Map<string, string>();
    installWindow({
      getPlatform: () => 'harmony',
      getCapabilities: () => JSON.stringify({ secureStorage: true }),
      secureStorageGet: (requestId: string, key: string) => {
        respondToHarmonyRequest(requestId, { ok: true, value: values.get(key) ?? null });
      },
      secureStorageSet: (requestId: string, key: string, value: string) => {
        values.set(key, value);
        respondToHarmonyRequest(requestId, { ok: true });
      },
      secureStorageRemove: (requestId: string, key: string) => {
        values.delete(key);
        respondToHarmonyRequest(requestId, { ok: true });
      },
    });

    const storage = getNativeMobileAdapter()?.secureStorage;
    expect(storage).toBeDefined();
    expect(await storage?.get('token-key')).toBeNull();
    await storage?.set('token-key', 'secret');
    expect(await storage?.get('token-key')).toBe('secret');
    await storage?.remove('token-key');
    expect(await storage?.get('token-key')).toBeNull();

    installWindow({
      getPlatform: () => 'harmony',
      getCapabilities: () => JSON.stringify({ secureStorage: true }),
      secureStorageGet: (requestId: string) => {
        respondToHarmonyRequest(requestId, { ok: false, error: 'invalid-input' });
      },
      secureStorageSet: (requestId: string) => {
        respondToHarmonyRequest(requestId, { ok: false });
      },
      secureStorageRemove: (requestId: string) => {
        respondToHarmonyRequest(requestId, { ok: false });
      },
    });
    const failedRead = getNativeMobileAdapter()?.secureStorage?.get('token-key');
    try {
      await failedRead;
      throw new Error('Expected secure storage read to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeMobileStorageError);
      expect((error as NativeMobileStorageError).reason).toBe('invalid-input');
    }
  });

  test('preserves invalid-secret as a typed storage failure', async () => {
    installWindow({
      getPlatform: () => 'harmony',
      getCapabilities: () => JSON.stringify({ secureStorage: true }),
      secureStorageGet: (requestId: string) => {
        respondToHarmonyRequest(requestId, { ok: false, error: 'invalid-secret' });
      },
      secureStorageSet: (requestId: string) => respondToHarmonyRequest(requestId, { ok: true }),
      secureStorageRemove: (requestId: string) => respondToHarmonyRequest(requestId, { ok: true }),
    });

    try {
      await getNativeMobileAdapter()?.secureStorage?.get('token-key');
      throw new Error('Expected invalid secret to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeMobileStorageError);
      expect((error as NativeMobileStorageError).reason).toBe('invalid-secret');
    }
  });

  test('subscribes to Harmony lifecycle state and removes the listener', () => {
    installWindow({
      getPlatform: () => 'harmony',
      getCapabilities: () => JSON.stringify({ lifecycle: true }),
    });

    const states: boolean[] = [];
    const lifecycle = getNativeMobileAdapter()?.lifecycle;
    expect(lifecycle).toBeDefined();
    const remove = lifecycle?.onAppStateChange((active) => states.push(active));
    const receiver = (globalThis.window as typeof window & {
      __openChamberHarmonyLifecycle?: (active: unknown) => void;
    }).__openChamberHarmonyLifecycle;
    receiver?.(false);
    receiver?.('invalid');
    receiver?.(true);
    expect(states).toEqual([false, true]);

    remove?.();
    receiver?.(false);
    expect(states).toEqual([false, true]);
  });

  test('rejects malformed native callback payloads', async () => {
    installWindow({
      getPlatform: () => 'harmony',
      getCapabilities: () => JSON.stringify({ secureStorage: true }),
      secureStorageGet: (requestId: string) => respondToHarmonyRequest(requestId, 'not-json'),
      secureStorageSet: (requestId: string) => respondToHarmonyRequest(requestId, 'not-json'),
      secureStorageRemove: (requestId: string) => respondToHarmonyRequest(requestId, 'not-json'),
    });

    try {
      await getNativeMobileAdapter()?.secureStorage?.set('token-key', 'secret');
      throw new Error('Expected malformed callback payload to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeMobileStorageError);
      expect((error as NativeMobileStorageError).reason).toBe('invalid-response');
    }
  });
});
