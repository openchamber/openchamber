import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { OpenChamberUIPluginManifestV1 } from '@/lib/uiPlugins';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const {
  findEnabledComposerStatusContributions,
  isUIPluginEnabled,
  useUIPluginsStore,
} = await import('./useUIPluginsStore');

const manifest = (id = '@example/session-status'): OpenChamberUIPluginManifestV1 => ({
  schemaVersion: 1,
  id,
  version: '0.1.0',
  displayName: { default: 'Session Status' },
  description: { default: 'Paint a chip in the composer footer.' },
  engines: { openchamber: '>=1.0.0' },
  contributes: {
    composerStatus: [{
      id: 'session-status',
      placement: 'footer',
      support: {
        web: 'supported',
        desktop: 'supported',
        vscode: 'unsupported',
        hostedMobile: 'supported',
        capacitorMobile: 'supported',
      },
    }],
  },
});

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('useUIPluginsStore', () => {
  beforeEach(() => {
    console.error = mock(() => undefined);
    useUIPluginsStore.setState({
      catalog: [manifest()],
      disabledPluginIds: [],
      isLoading: false,
      loadError: false,
    });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  test('loads and validates the server catalog', async () => {
    globalThis.fetch = mock(async () => response({ plugins: [manifest('@example/other')] })) as unknown as typeof fetch;
    expect(await useUIPluginsStore.getState().loadCatalog()).toBe(true);
    expect(useUIPluginsStore.getState().catalog[0]?.id).toBe('@example/other');
    expect(useUIPluginsStore.getState().loadError).toBe(false);
  });

  test('preserves the last valid catalog when the authoritative fetch fails', async () => {
    const previousCatalog = useUIPluginsStore.getState().catalog;
    globalThis.fetch = mock(async () => response({ error: 'offline' }, 503)) as unknown as typeof fetch;
    expect(await useUIPluginsStore.getState().loadCatalog()).toBe(false);
    expect(useUIPluginsStore.getState().catalog).toBe(previousCatalog);
    expect(useUIPluginsStore.getState().loadError).toBe(true);
  });

  test('rejects malformed catalogs without partially replacing valid entries', async () => {
    const previousCatalog = useUIPluginsStore.getState().catalog;
    globalThis.fetch = mock(async () => response({ plugins: [manifest(), { schemaVersion: 1 }] })) as unknown as typeof fetch;
    expect(await useUIPluginsStore.getState().loadCatalog()).toBe(false);
    expect(useUIPluginsStore.getState().catalog).toBe(previousCatalog);
  });

  test('enablement controls contribution lookup without mutating the catalog', () => {
    const id = '@example/session-status';
    useUIPluginsStore.getState().setPluginEnabled(id, false);
    const state = useUIPluginsStore.getState();
    expect(isUIPluginEnabled(state, id)).toBe(false);
    expect(findEnabledComposerStatusContributions(state)).toEqual([]);
    expect(state.catalog).toHaveLength(1);
    useUIPluginsStore.getState().setPluginEnabled(id, true);
    expect(findEnabledComposerStatusContributions(useUIPluginsStore.getState())).toHaveLength(1);
  });

  test('a stale catalog response cannot overwrite a newer runtime response', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const alternate = manifest('@example/new-runtime');
    globalThis.fetch = mock(() => {
      if (!resolveFirst) {
        return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve(response({ plugins: [alternate] }));
    }) as unknown as typeof fetch;

    const staleRequest = useUIPluginsStore.getState().loadCatalog();
    const currentRequest = useUIPluginsStore.getState().loadCatalog();
    expect(await currentRequest).toBe(true);
    resolveFirst?.(response({ plugins: [manifest()] }));
    expect(await staleRequest).toBe(false);
    expect(useUIPluginsStore.getState().catalog[0]?.id).toBe(alternate.id);
  });

  test('malformed persisted enablement fails open instead of breaking contribution lookup', () => {
    const malformed = { ...useUIPluginsStore.getState(), disabledPluginIds: null } as unknown as Parameters<typeof isUIPluginEnabled>[0];
    expect(isUIPluginEnabled(malformed, '@example/session-status')).toBe(true);
  });
});
