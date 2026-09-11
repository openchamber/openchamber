import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-quota-')), 'api-key');
fs.writeFileSync(keyFile, 'file-reference-token\n');

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({}),
}));

vi.mock('../../opencode/shared.js', () => ({
  OPENCODE_CONFIG_DIR: '/tmp/opencode-test-config',
  readConfigLayers: vi.fn(() => ({
    mergedConfig: {
      provider: {
        'zhipuai-coding-plan': { options: { apiKey: `{file:${keyFile}}` } },
      },
    },
  })),
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
  it('resolves {file:...} apiKey references from provider config', async () => {
    let authHeader = null;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      authHeader = init.headers.Authorization;
      return mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 36 },
          ],
        },
      });
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(authHeader).toBe('Bearer file-reference-token');
    expect(result.usage.windows['Tokens']).toMatchObject({ usedPercent: 36 });
  });

  it('keeps the raw value when the referenced file is unreadable', async () => {
    let authHeader = null;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      authHeader = init.headers.Authorization;
      return mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 36 },
          ],
        },
      });
    }));

    const { readConfigLayers } = await import('../../opencode/shared.js');
    const brokenKeyFile = `{file:${path.join(os.tmpdir(), 'openchamber-quota', 'missing-key')}}`;
    vi.mocked(readConfigLayers).mockImplementationOnce(() => ({
      mergedConfig: {
        provider: {
          'zhipuai-coding-plan': { options: { apiKey: `${brokenKeyFile}` } },
        },
      },
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(authHeader).toBe(`Bearer ${brokenKeyFile}`);
  });
});
