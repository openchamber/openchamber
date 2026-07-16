import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The config fallback must resolve {env:}/{file:} placeholders instead of
// sending the literal token to the quota API (#2269).

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: vi.fn(),
  writeAuthFile: vi.fn(),
}));

vi.mock('../../opencode/shared.js', () => ({
  readConfig: vi.fn(),
  readConfigLayers: vi.fn(),
}));

const { isConfigured, fetchQuota } = await import('./zhipuai-coding-plan.js');
const { readConfigLayers } = await import('../../opencode/shared.js');
const { readAuthFile } = await import('../../opencode/auth.js');

const quotaOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 12 }] } }),
});

describe('Zhipu AI Coding Plan quota provider — config apiKey resolution', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    readAuthFile.mockReset();
    readConfigLayers.mockReset();
    readAuthFile.mockReturnValue({});
    readConfigLayers.mockReturnValue({
      mergedConfig: {
        provider: {
          zhipuai: { options: { apiKey: '{env:OPENCHAMBER_TEST_ZHIPU_KEY}' } },
        },
      },
      paths: {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.OPENCHAMBER_TEST_ZHIPU_KEY;
  });

  it('expands a {env:...} config apiKey before calling the quota API', async () => {
    process.env.OPENCHAMBER_TEST_ZHIPU_KEY = 'sk-zhipu-real';
    fetchMock.mockResolvedValue(quotaOk());

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls.at(-1);
    expect(init.headers.Authorization).toBe('Bearer sk-zhipu-real');
    expect(JSON.stringify(init)).not.toContain('{env:');
  });

  it('treats an unresolvable {env:...} apiKey as not configured', async () => {
    expect(isConfigured()).toBe(false);

    const result = await fetchQuota();
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still prefers the auth.json credential over the config key', async () => {
    process.env.OPENCHAMBER_TEST_ZHIPU_KEY = 'sk-zhipu-config';
    readAuthFile.mockReturnValue({
      'zhipuai-coding-plan': { type: 'api', key: 'sk-zhipu-auth' },
    });
    fetchMock.mockResolvedValue(quotaOk());

    await fetchQuota();

    expect(fetchMock.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer sk-zhipu-auth');
  });
});
