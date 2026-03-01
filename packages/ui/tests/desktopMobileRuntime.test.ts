import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDesktopShell, isMobileRuntime, isTauriMobileShell } from '../src/lib/desktop';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const setTestGlobals = ({
  runtimePlatform,
  tauriInvoke = false,
  userAgent = 'Mozilla/5.0',
}: {
  runtimePlatform?: 'mobile' | 'desktop' | 'web' | 'vscode';
  tauriInvoke?: boolean;
  userAgent?: string;
}) => {
  const runtime = runtimePlatform
    ? { runtime: { platform: runtimePlatform, isDesktop: runtimePlatform === 'desktop', isVSCode: runtimePlatform === 'vscode' } }
    : undefined;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      __OPENCHAMBER_RUNTIME_APIS__: runtime,
      __TAURI__: tauriInvoke ? { core: { invoke: () => Promise.resolve(undefined) } } : undefined,
      __OPENCHAMBER_LOCAL_ORIGIN__: '',
      location: { origin: 'http://localhost:5173' },
    },
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { userAgent },
  });
};

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
});

describe('desktop/mobile runtime detection', () => {
  it('treats runtime mobile platform as tauri mobile shell', () => {
    setTestGlobals({ runtimePlatform: 'mobile', tauriInvoke: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    assert.equal(isTauriMobileShell(), true);
    assert.equal(isMobileRuntime(), true);
    assert.equal(isDesktopShell(), false);
  });

  it('falls back to tauri+mobile user agent when runtime descriptor is missing', () => {
    setTestGlobals({ tauriInvoke: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8)' });
    assert.equal(isTauriMobileShell(), true);
    assert.equal(isMobileRuntime(), true);
    assert.equal(isDesktopShell(), false);
  });

  it('does not classify tauri desktop user agent as mobile', () => {
    setTestGlobals({ tauriInvoke: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' });
    assert.equal(isTauriMobileShell(), false);
    assert.equal(isMobileRuntime(), false);
    assert.equal(isDesktopShell(), true);
  });
});
