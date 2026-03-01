import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticateWithBiometrics,
  getBiometricStatus,
  openExternalUrl,
  requestNativeNotificationPermission,
  writeTextToClipboard,
} from '../src/lib/desktop';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalNotificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

const setWindow = (value: unknown) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value,
  });
};

const setNavigator = (value: unknown) => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value,
  });
};

const runtimeDescriptor = (platform: 'mobile' | 'desktop' | 'web' | 'vscode') => ({
  runtime: {
    platform,
    isDesktop: platform === 'desktop',
    isVSCode: platform === 'vscode',
  },
});

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }

  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }

  if (originalNotificationDescriptor) {
    Object.defineProperty(globalThis, 'Notification', originalNotificationDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'Notification');
  }
});

describe('desktop native plugin helpers', () => {
  it('uses tauri clipboard manager when available', async () => {
    let copied = '';
    setWindow({
      __OPENCHAMBER_RUNTIME_APIS__: runtimeDescriptor('mobile'),
      __TAURI__: {
        core: { invoke: async () => undefined },
        clipboardManager: {
          writeText: async (value: string) => {
            copied = value;
          },
        },
      },
    });

    const ok = await writeTextToClipboard('hello');
    assert.equal(ok, true);
    assert.equal(copied, 'hello');
  });

  it('falls back to navigator clipboard when tauri clipboard is unavailable', async () => {
    let copied = '';
    setWindow({
      __OPENCHAMBER_RUNTIME_APIS__: runtimeDescriptor('web'),
    });
    setNavigator({
      clipboard: {
        writeText: async (value: string) => {
          copied = value;
        },
      },
    });

    const ok = await writeTextToClipboard('fallback');
    assert.equal(ok, true);
    assert.equal(copied, 'fallback');
  });

  it('uses tauri opener plugin when available', async () => {
    let opened = '';
    setWindow({
      __OPENCHAMBER_RUNTIME_APIS__: runtimeDescriptor('mobile'),
      __TAURI__: {
        core: { invoke: async () => undefined },
        opener: {
          openUrl: async (url: string) => {
            opened = url;
          },
        },
      },
    });

    const ok = await openExternalUrl('https://example.com');
    assert.equal(ok, true);
    assert.equal(opened, 'https://example.com');
  });

  it('requests native notification permission through tauri plugin', async () => {
    setWindow({
      __OPENCHAMBER_RUNTIME_APIS__: runtimeDescriptor('mobile'),
      __TAURI__: {
        core: { invoke: async () => undefined },
        notification: {
          isPermissionGranted: async () => false,
          requestPermission: async () => 'granted',
        },
      },
    });

    const permission = await requestNativeNotificationPermission();
    assert.equal(permission, 'granted');
  });

  it('returns unavailable biometric status outside native mobile runtime', async () => {
    setWindow({
      __OPENCHAMBER_RUNTIME_APIS__: runtimeDescriptor('desktop'),
      __TAURI__: {
        core: { invoke: async () => undefined },
      },
    });

    const status = await getBiometricStatus();
    assert.equal(status.isAvailable, false);
    assert.equal(status.error, 'not_mobile');
  });

  it('authenticates with biometric plugin on native mobile runtime', async () => {
    let called = false;
    setWindow({
      __OPENCHAMBER_RUNTIME_APIS__: runtimeDescriptor('mobile'),
      __TAURI__: {
        core: { invoke: async () => undefined },
        biometric: {
          authenticate: async () => {
            called = true;
          },
        },
      },
    });

    const ok = await authenticateWithBiometrics('Unlock OpenChamber');
    assert.equal(ok, true);
    assert.equal(called, true);
  });
});
