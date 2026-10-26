import { expect, spyOn, test } from 'bun:test';
import { getRuntimeApiBaseUrl, getRuntimeKey, initializeRuntimeEndpoint } from '@/lib/runtime-switch';
import { useConfigStore } from './useConfigStore';
import { useQuotaStore } from './useQuotaStore';

test('Electron dev loads usage through its same-origin proxy before Settings opens', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousInitialized = useConfigStore.getState().isInitialized;
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://localhost:5173', href: 'http://localhost:5173/' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://localhost:3901',
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  const requests: string[] = [];
  const network = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = input.toString();
    requests.push(path);
    if (path === '/api/config/settings?surface=desktop') {
      return Response.json({ usageDropdownProviders: ['codex'] });
    }
    if (path === '/api/quota/codex') {
      return Response.json({
        providerId: 'codex', providerName: 'Codex', ok: true, configured: true, fetchedAt: 123,
        usage: { windows: { '5h': {
          usedPercent: 42, remainingPercent: 58, windowSeconds: 18000,
          resetAfterSeconds: 100, resetAt: 1000, resetAtFormatted: null, resetAfterFormatted: null,
        } } },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  try {
    // Electron deliberately omits the API base when Vite proxies the backend.
    initializeRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: null });
    useConfigStore.setState({ isInitialized: true });
    useQuotaStore.getState().resetForRuntimeSwitch();
    await useQuotaStore.getState().ensureLoadedForRuntime();

    expect(requests).toEqual(['/api/config/settings?surface=desktop', '/api/quota/codex']);
    expect(getRuntimeKey()).toBe('local');
    expect(getRuntimeApiBaseUrl()).toBe('');
    expect(useQuotaStore.getState().loadedRuntimeKey).toBe('local');
    expect(useQuotaStore.getState().results[0]?.usage?.windows['5h'].remainingPercent).toBe(58);

    await useQuotaStore.getState().ensureLoadedForRuntime();
    expect(requests).toHaveLength(2);
  } finally {
    useQuotaStore.getState().resetForRuntimeSwitch();
    useConfigStore.setState({ isInitialized: previousInitialized });
    network.mockRestore();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
