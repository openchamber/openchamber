import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { create } from 'zustand';

// Deterministic coverage for the registration/disable race in
// useNativePushRegistration (#2159): a registration callback parked on the
// async PushKey lookup must not POST after notifications are disabled, and
// a registration POST already in flight must settle before the disable
// path's DELETE so the final server state is unregistered.

const VALID_PUSH_KEY = `${'A'.repeat(43)}=`;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// --- Controllable stubs, wired in through module mocks below. ---
let pushKeyRequest: Deferred<{ key: string }>;
let registrationRequest: Deferred<unknown> | null;
let callOrder: string[] = [];
let registerPayloads: unknown[] = [];
let unregisterPayloads: unknown[] = [];
const listeners = new Map<string, (arg: never) => void>();

const pushKeyStub = {
  get: () => pushKeyRequest.promise,
  pushAvailable: async () => ({ available: true }),
};

const pushNotificationsStub = {
  checkPermissions: async () => ({ receive: 'granted' as const }),
  requestPermissions: async () => ({ receive: 'granted' as const }),
  addListener: async (eventName: string, callback: (arg: never) => void) => {
    listeners.set(eventName, callback);
    return { remove: async () => { listeners.delete(eventName); } };
  },
  register: async () => undefined,
};

const registerApnsToken = (payload: unknown) => {
  callOrder.push('register');
  registerPayloads.push(payload);
  return registrationRequest ? registrationRequest.promise : Promise.resolve();
};

const unregisterApnsToken = (payload: unknown) => {
  callOrder.push('unregister');
  unregisterPayloads.push(payload);
  return Promise.resolve();
};

const useUIStoreStub = create<{ nativeNotificationsEnabled: boolean }>()(() => ({
  nativeNotificationsEnabled: true,
}));

mock.module('@capacitor/core', () => ({
  registerPlugin: () => pushKeyStub,
}));

mock.module('@capacitor/push-notifications', () => ({
  PushNotifications: pushNotificationsStub,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => ({ push: { registerApnsToken, unregisterApnsToken } }),
}));

mock.module('@/lib/platform', () => ({
  getClientPlatform: () => 'android',
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: useUIStoreStub,
}));

let useNativePushRegistration: (options: { enabled: boolean }) => void;

beforeAll(async () => {
  ({ useNativePushRegistration } = await import('./useNativePushRegistration'));
});

const flush = async (turns = 12) => {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe('useNativePushRegistration disable race (#2159)', () => {
  let root: Root;
  const globals = new Map<string, PropertyDescriptor | undefined>();

  const Probe = () => {
    useNativePushRegistration({ enabled: true });
    return null;
  };

  beforeEach(() => {
    pushKeyRequest = deferred<{ key: string }>();
    registrationRequest = null;
    callOrder = [];
    registerPayloads = [];
    unregisterPayloads = [];
    listeners.clear();
    useUIStoreStub.setState({ nativeNotificationsEnabled: true });

    const window = new Window({ url: 'http://localhost/' });
    (window as unknown as { Capacitor: unknown }).Capacitor = { getPlatform: () => 'android' };
    for (const [key, value] of Object.entries({
      window,
      document: window.document,
      navigator: window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const renderAndCaptureListener = async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    await flush();
    const listener = listeners.get('registration');
    expect(listener).toBeDefined();
    return listener!;
  };

  const fireRegistration = async (listener: (arg: never) => void, token: string) => {
    await act(async () => {
      (listener as (arg: { value: string }) => void)({ value: token });
    });
    await flush(2);
  };

  const setNotificationsEnabled = async (value: boolean) => {
    await act(async () => {
      useUIStoreStub.setState({ nativeNotificationsEnabled: value });
    });
    await flush(3);
  };

  test('a callback parked on the key lookup does not register after disable', async () => {
    const listener = await renderAndCaptureListener();
    await fireRegistration(listener, 'token-1');

    // Disable while PushKey.get() is still pending: the disable path
    // unregisters the stored token.
    await setNotificationsEnabled(false);
    expect(unregisterPayloads).toEqual([{ token: 'token-1' }]);

    // The delayed key lookup resolves now — too late to register.
    pushKeyRequest.resolve({ key: VALID_PUSH_KEY });
    await flush();
    expect(registerPayloads).toEqual([]);
    expect(callOrder).toEqual(['unregister']);
  });

  test('an in-flight registration settles before the disable unregister', async () => {
    registrationRequest = deferred<unknown>();
    const listener = await renderAndCaptureListener();
    await fireRegistration(listener, 'token-1');
    pushKeyRequest.resolve({ key: VALID_PUSH_KEY });
    await flush();
    expect(registerPayloads).toHaveLength(1);

    // Disable while the POST is in flight: the DELETE must wait for it.
    await setNotificationsEnabled(false);
    expect(unregisterPayloads).toEqual([]);

    registrationRequest.resolve(undefined);
    await flush();
    expect(unregisterPayloads).toEqual([{ token: 'token-1' }]);
    expect(callOrder).toEqual(['register', 'unregister']);
  });

  test('registers on connect while notifications stay enabled', async () => {
    const listener = await renderAndCaptureListener();
    await fireRegistration(listener, 'token-1');
    pushKeyRequest.resolve({ key: VALID_PUSH_KEY });
    await flush();

    expect(registerPayloads).toEqual([
      { token: 'token-1', platform: 'android', environment: undefined, pushKey: VALID_PUSH_KEY },
    ]);
    expect(unregisterPayloads).toEqual([]);
  });
});
