import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const originalFetch = globalThis.fetch;

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => ({ path: '/workspace/project' }),
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/fallback/project',
    // Required when other suites later import stores that call setDirectory at module init.
    setDirectory: () => undefined,
    sendMessage: async () => 'msg',
    shellSession: async () => undefined,
    sendCommand: async () => undefined,
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const { useHarnessStore } = await import('./useHarnessStore');

const opencodeCatalog = {
  engine: {
    id: 'opencode',
    displayName: 'OpenCode',
    shortName: 'OpenCode',
    auth: { mode: 'opencode-providers' },
    capabilities: {
      prompt: 'full',
      abort: 'full',
      resume: 'full',
      'streaming-text': 'full',
      'streaming-tools': 'full',
      permissions: 'full',
      images: 'full',
      'file-attachments': 'full',
      shell: 'full',
      'slash-commands': 'full',
      mcp: 'full',
      subagents: 'full',
      multirun: 'full',
      goal: 'full',
      'openchamber-tool': 'full',
    },
    install: { binaryNames: [], docsUrl: 'https://example.com/opencode' },
  },
  status: 'ready',
  sections: [],
};

const claudeCatalog = {
  engine: {
    id: 'claude-code',
    displayName: 'Claude Code',
    shortName: 'Claude',
    auth: { mode: 'subscription-cli' },
    capabilities: {
      prompt: 'full',
      abort: 'full',
      resume: 'full',
      'streaming-text': 'full',
      'streaming-tools': 'full',
      permissions: 'full',
      images: 'full',
      'file-attachments': 'full',
      shell: 'partial',
      'slash-commands': 'partial',
      mcp: 'partial',
      subagents: 'partial',
      multirun: 'full',
      goal: 'full',
      'openchamber-tool': 'full',
    },
    install: { binaryNames: ['claude'], docsUrl: 'https://example.com/claude' },
  },
  status: 'needs-login',
  version: '1.2.3',
  sections: [{ id: 'models', name: 'Models', kind: 'models', models: [{ id: 'sonnet', name: 'Sonnet' }] }],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () =>
  jsonResponse({ engines: [opencodeCatalog, claudeCatalog] });

beforeEach(() => {
  useHarnessStore.getState().resetForRuntimeSwitch();
  fetchImpl = async () => jsonResponse({ engines: [opencodeCatalog, claudeCatalog] });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init)) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('useHarnessStore', () => {
  test('refresh loads catalogs on success', async () => {
    const ok = await useHarnessStore.getState().refresh({ force: true });
    expect(ok).toBe(true);
    const state = useHarnessStore.getState();
    expect(state.loadState).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.catalogs).toHaveLength(2);
    expect(state.catalogsById['claude-code']?.status).toBe('needs-login');
    expect(state.catalogsById['claude-code']?.version).toBe('1.2.3');
  });

  test('fetch failure does not clear prior catalogs to fake ready empty', async () => {
    expect(await useHarnessStore.getState().refresh({ force: true })).toBe(true);
    expect(useHarnessStore.getState().catalogs).toHaveLength(2);

    fetchImpl = async () => jsonResponse({ error: 'boom' }, 503);
    const ok = await useHarnessStore.getState().refresh({ force: true });
    expect(ok).toBe(false);

    const state = useHarnessStore.getState();
    expect(state.catalogs).toHaveLength(2);
    expect(state.catalogsById.opencode?.status).toBe('ready');
    expect(state.error).toBe('boom');
    expect(state.loadState).toBe('ready');
  });

  test('first-load failure is error with empty catalogs, not ready empty', async () => {
    fetchImpl = async () => jsonResponse({ error: 'missing' }, 404);
    const ok = await useHarnessStore.getState().refresh({ force: true });
    expect(ok).toBe(false);

    const state = useHarnessStore.getState();
    expect(state.catalogs).toEqual([]);
    expect(state.loadState).toBe('error');
    expect(state.error).toBeTruthy();
  });

  test('malformed success body is failure, not ready empty', async () => {
    fetchImpl = async () => jsonResponse({ engines: [{ bad: true }] });
    const ok = await useHarnessStore.getState().refresh({ force: true });
    expect(ok).toBe(false);
    const state = useHarnessStore.getState();
    expect(state.catalogs).toEqual([]);
    expect(state.loadState).toBe('error');
  });

  test('detect updates one engine without clearing others on failure', async () => {
    expect(await useHarnessStore.getState().refresh({ force: true })).toBe(true);

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes('/detect')) {
        return jsonResponse({
          ...claudeCatalog,
          status: 'ready',
          version: '9.9.9',
        });
      }
      return jsonResponse({ engines: [opencodeCatalog, claudeCatalog] });
    };

    expect(await useHarnessStore.getState().detect('claude-code')).toBe(true);
    expect(useHarnessStore.getState().catalogsById['claude-code']?.status).toBe('ready');
    expect(useHarnessStore.getState().catalogsById['claude-code']?.version).toBe('9.9.9');
    expect(useHarnessStore.getState().catalogsById.opencode?.status).toBe('ready');

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes('/detect')) {
        return jsonResponse({ error: 'detect failed' }, 500);
      }
      return jsonResponse({ engines: [opencodeCatalog, claudeCatalog] });
    };

    expect(await useHarnessStore.getState().detect('claude-code')).toBe(false);
    const state = useHarnessStore.getState();
    expect(state.catalogsById['claude-code']?.status).toBe('ready');
    expect(state.catalogsById.opencode?.status).toBe('ready');
    expect(state.error).toBe('detect failed');
  });
});
