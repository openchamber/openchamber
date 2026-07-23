import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Full-flow coverage for issue #2269: a session-goal audit on a provider
// defined only in the OpenCode config with an `{env:...}` apiKey must run
// with the expanded credential instead of settling the goal as blocked.

// Keep a real settings override on the host machine out of these tests.
process.env.OPENCHAMBER_DATA_DIR = '/nonexistent/openchamber-test-data';

vi.mock('../opencode/auth.js', () => ({
  readAuthFile: vi.fn(),
  writeAuthFile: vi.fn(),
}));

vi.mock('../opencode/shared.js', () => ({
  readConfig: vi.fn(),
  readConfigLayers: vi.fn(),
}));

vi.mock('./catalog.js', () => ({
  getCatalogProvider: vi.fn((catalog, providerID) => catalog?.[providerID] ?? null),
  getModelCatalog: vi.fn(async () => ({})),
}));

const { generateSmallModelText } = await import('./index.js');
const { readConfig, readConfigLayers } = await import('../opencode/shared.js');
const { readAuthFile } = await import('../opencode/auth.js');

// The settings path is captured at import time; don't leak the override.
delete process.env.OPENCHAMBER_DATA_DIR;

const ok = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content }, finish_reason: 'stop' }],
  }),
  text: async () => JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
  }),
});

const CONFIG_ONLY_PROVIDER = {
  provider: {
    'custom-provider': {
      options: {
        apiKey: '{env:OPENCHAMBER_TEST_CUSTOM_KEY}',
        baseURL: 'https://api.example.test/v1',
      },
    },
  },
};

describe('generateSmallModelText — config-only provider with {env:...} credential (issue #2269)', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    readConfig.mockReset();
    readConfigLayers.mockReset();
    readAuthFile.mockReset();
    readAuthFile.mockReturnValue({});
    readConfig.mockReturnValue(CONFIG_ONLY_PROVIDER);
    readConfigLayers.mockReturnValue({ mergedConfig: {}, paths: {} });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.OPENCHAMBER_TEST_CUSTOM_KEY;
  });

  it('audits on the session provider with the expanded credential', async () => {
    process.env.OPENCHAMBER_TEST_CUSTOM_KEY = 'sk-valid-key-here';
    fetchMock.mockResolvedValue(ok('{"verdict":"continue"}'));

    const result = await generateSmallModelText({
      prompt: 'Audit progress',
      system: 'You are an auditor',
      directory: '/proj',
      preferredProviderID: 'custom-provider',
      preferredModelID: 'audit-model',
      restrictToPreferredProvider: true,
    });

    expect(result.providerID).toBe('custom-provider');
    expect(result.modelID).toBe('audit-model');
    expect(result.source).toBe('session-model');
    expect(result.text).toBe('{"verdict":"continue"}');

    const [url, init] = fetchMock.mock.calls.at(-1);
    expect(String(url)).toBe('https://api.example.test/v1/chat/completions');
    // The expanded key is sent; the raw placeholder never leaves the process.
    expect(init.headers.Authorization).toBe('Bearer sk-valid-key-here');
    expect(JSON.stringify(init)).not.toContain('{env:');
  });

  it('fails with 404 and no request when the env var is unset in this process', async () => {
    await expect(generateSmallModelText({
      prompt: 'Audit progress',
      directory: '/proj',
      preferredProviderID: 'custom-provider',
      preferredModelID: 'audit-model',
      restrictToPreferredProvider: true,
    })).rejects.toThrow('No small model available');

    // No literal placeholder sent (the 401 from the report), no provider switch.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
