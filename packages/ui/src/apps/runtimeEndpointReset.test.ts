import { afterEach, describe, expect, test } from 'bun:test';
import { installRuntimeEndpointReset } from './runtimeEndpointReset';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;

const installWindow = (): void => {
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
};

// The switch mints a URL auth token in the background; answer it locally so the
// test never reaches the network.
const stubFetch = (): void => {
  // SAFETY: the endpoint switch only calls fetch(input, init); Bun's extra
  // `preconnect` member is never read.
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('installRuntimeEndpointReset', () => {
  // #4219: the login screen unmounts App, so a host switch made from it must
  // still move the SDK client; otherwise App mounts against Local with a client
  // that keeps calling the remote and the startup overlay never lifts.
  test('rebinds the SDK client and resets init state without any mounted UI', () => {
    installWindow();
    stubFetch();
    const uninstall = installRuntimeEndpointReset();
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
      expect(opencodeClient.getBaseUrl().startsWith('https://remote.example')).toBe(true);

      useConfigStore.setState({ isInitialized: true, isConnected: true });
      switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:4100', runtimeKey: 'local' });

      expect(opencodeClient.getBaseUrl().startsWith('http://127.0.0.1:4100')).toBe(true);
      expect(useConfigStore.getState().isInitialized).toBe(false);
      expect(useConfigStore.getState().isConnected).toBe(false);
    } finally {
      uninstall();
    }
  });

  // The login gate re-applies the same endpoint with a fresh client token after
  // sign-in, while App is unmounted. That must not wipe the host's state.
  test('leaves a same-runtime credential change to App', () => {
    installWindow();
    stubFetch();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
    const uninstall = installRuntimeEndpointReset();
    try {
      useConfigStore.setState({ isInitialized: true, isConnected: true });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', clientToken: 'fresh-token', runtimeKey: 'remote' });

      expect(useConfigStore.getState().isInitialized).toBe(true);
      expect(useConfigStore.getState().isConnected).toBe(true);
    } finally {
      uninstall();
    }
  });

  test('stops resetting once uninstalled', () => {
    installWindow();
    stubFetch();
    const uninstall = installRuntimeEndpointReset();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://first.example', runtimeKey: 'first' });
    uninstall();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://second.example', runtimeKey: 'second' });

    expect(opencodeClient.getBaseUrl().startsWith('https://first.example')).toBe(true);
  });
});
