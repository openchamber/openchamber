import { afterEach, describe, expect, it, vi } from 'vitest';

let authFile = {};
vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => authFile,
}));

import { fetchQuota, fetchQuotaAddon } from './copilot.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockQuotaResponse = () => ({
  quota_snapshots: {
    chat: { entitlement: 100, remaining: 80 },
  },
});

describe('copilot quota provider', () => {
  it('uses enterprise endpoint and appends hostname to provider name', async () => {
    authFile = {
      'github-copilot': {
        type: 'oauth',
        access: 'token',
        enterpriseUrl: 'ghe.example.com',
      },
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockQuotaResponse(),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ghe.example.com/api/v3/copilot_internal/user',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.providerName).toBe('GitHub Copilot (ghe.example.com)');
  });

  it('keeps github.com endpoint and base provider name for non-enterprise auth', async () => {
    authFile = {
      'github-copilot': {
        type: 'oauth',
        access: 'token',
      },
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockQuotaResponse(),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuotaAddon();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/copilot_internal/user',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.providerName).toBe('GitHub Copilot Add-on');
  });
});
