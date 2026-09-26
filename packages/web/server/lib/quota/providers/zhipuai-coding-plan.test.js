import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({}),
}));

vi.mock('../../opencode/shared.js', () => ({
  OPENCODE_CONFIG_DIR: '/tmp/opencode-test-config',
  readConfigLayers: () => ({
    mergedConfig: {
      provider: {
        'zhipuai-coding-plan': { options: { apiKey: 'test-token' } },
      },
    },
  }),
}));

import { fetchQuota } from './zhipuai-coding-plan.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('Zhipu AI Coding Plan quota provider', () => {
  it('reads the API key from provider config when auth.json has no entry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 36 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0 },
        ],
      },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows['Tokens']).toMatchObject({
      usedPercent: 36,
      windowSeconds: 5 * 60 * 60,
    });
  });

  it('surfaces business-layer auth errors returned with HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      code: 401,
      success: false,
      msg: 'token expired or incorrect',
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('token expired or incorrect');
    expect(result.usage).toBeNull();
  });
});
