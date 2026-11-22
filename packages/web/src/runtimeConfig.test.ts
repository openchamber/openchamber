import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { createConfiguredWebAPIs, readRuntimeBootstrapConfig } from './runtimeConfig';
import type { RuntimeConfigDeps } from './runtimeConfig';

// Dependency seams: the side-effecting runtime collaborators are injected
// into createConfiguredWebAPIs instead of mocked at the module boundary.
// The URL resolver, boot-outcome reader, and Web API factory stay real.
const initializeRuntimeEndpoint = vi.fn();
const restoreDesktopRelayRuntime = vi.fn(() => Promise.resolve());

const testDeps: Partial<RuntimeConfigDeps> = {
  getRuntimeExtraHeadersSync: () => ({}),
  refreshLocalRuntimeUrlAuthToken: () => Promise.resolve(''),
  refreshRuntimeUrlAuthToken: () => Promise.resolve(''),
  setRuntimeBearerToken: () => {},
  setRuntimeExtraHeaders: () => {},
  installRuntimeFetchBridge: () => {},
  initializeRuntimeEndpoint,
  warmDesktopHostStatuses: () => Promise.resolve(),
  restoreDesktopRelayRuntime,
  reconnectToRuntimeBaseUrl: () => {},
};


const originalWindow = globalThis.window;

const installWindow = (value: Record<string, unknown>) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
  });
};

const makeWindow = (search = ''): Record<string, unknown> => {
  const value: Record<string, unknown> = {
    location: { origin: 'openchamber-ui://app', search },
    setTimeout: vi.fn(() => 1),
  };
  value.parent = value;
  return value;
};

beforeEach(() => {
  vi.clearAllMocks();
  installWindow(makeWindow());
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('readRuntimeBootstrapConfig', () => {
  test('reads the runtime injected into the current window', () => {
    const current = makeWindow();
    current.__OPENCHAMBER_API_BASE_URL__ = ' https://remote.example.com ';
    current.__OPENCHAMBER_CLIENT_TOKEN__ = ' remote-token ';
    current.__OPENCHAMBER_LOCAL_ORIGIN__ = ' http://127.0.0.1:3000 ';
    current.__OPENCHAMBER_RUNTIME_HEADERS__ = { 'x-openchamber-relay': 'relay-value' };
    current.__OPENCHAMBER_RELAY_HOST_ID__ = ' remote-host ';
    installWindow(current);

    expect(readRuntimeBootstrapConfig()).toEqual({
      apiBaseUrl: 'https://remote.example.com',
      clientToken: 'remote-token',
      localOrigin: 'http://127.0.0.1:3000',
      runtimeHeaders: { 'x-openchamber-relay': 'relay-value' },
      relayHostId: 'remote-host',
      explicitRuntime: false,
    });
  });

  test('does not read runtime credentials directly from a parent window', () => {
    const parent = makeWindow();
    parent.__OPENCHAMBER_API_BASE_URL__ = 'https://remote.example.com';
    parent.__OPENCHAMBER_CLIENT_TOKEN__ = 'remote-token';
    const child = makeWindow();
    child.parent = parent;
    installWindow(child);

    expect(readRuntimeBootstrapConfig()).toEqual({
      apiBaseUrl: '',
      clientToken: '',
      localOrigin: '',
      runtimeHeaders: undefined,
      relayHostId: '',
      explicitRuntime: false,
    });
  });
});

describe('createConfiguredWebAPIs', () => {
  test('uses the configured desktop host id across changing SSH tunnel URLs', () => {
    const current = makeWindow();
    current.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ = {
      target: 'remote',
      status: 'ok',
      hostId: 'ssh-castle',
      url: 'http://127.0.0.1:62545',
      localAvailable: true,
    };
    current.__OPENCHAMBER_API_BASE_URL__ = 'http://127.0.0.1:62545';
    current.__OPENCHAMBER_LOCAL_ORIGIN__ = 'http://127.0.0.1:3901';
    installWindow(current);

    createConfiguredWebAPIs(testDeps);

    expect(initializeRuntimeEndpoint).toHaveBeenCalledWith({
      apiBaseUrl: 'http://127.0.0.1:62545',
      runtimeKey: 'host:ssh-castle',
    });
  });

  test('a window opened for an explicit instance keeps its runtime instead of the default host', () => {
    const current = makeWindow();
    current.__OPENCHAMBER_API_BASE_URL__ = 'http://127.0.0.1:3901';
    current.__OPENCHAMBER_LOCAL_ORIGIN__ = 'http://127.0.0.1:3901';
    current.__OPENCHAMBER_EXPLICIT_RUNTIME__ = true;
    installWindow(current);

    createConfiguredWebAPIs(testDeps);

    expect(restoreDesktopRelayRuntime).not.toHaveBeenCalled();
  });

  test('a relay-capable explicit window still restores through its injected host id', () => {
    const current = makeWindow();
    current.__OPENCHAMBER_API_BASE_URL__ = 'http://127.0.0.1:3901';
    current.__OPENCHAMBER_LOCAL_ORIGIN__ = 'http://127.0.0.1:3901';
    current.__OPENCHAMBER_RELAY_HOST_ID__ = 'relay-host';
    current.__OPENCHAMBER_EXPLICIT_RUNTIME__ = true;
    installWindow(current);

    createConfiguredWebAPIs(testDeps);

    expect(restoreDesktopRelayRuntime).toHaveBeenCalledWith('relay-host', { reconnectActive: true });
  });

  test('the main window still restores the default host', () => {
    const current = makeWindow();
    current.__OPENCHAMBER_API_BASE_URL__ = 'http://127.0.0.1:3901';
    current.__OPENCHAMBER_LOCAL_ORIGIN__ = 'http://127.0.0.1:3901';
    installWindow(current);

    createConfiguredWebAPIs(testDeps);

    expect(restoreDesktopRelayRuntime).toHaveBeenCalledWith();
  });
});
