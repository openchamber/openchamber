import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ 'zhipuai-coding-plan': { key: 'test-token' } }),
}));
vi.mock('../../opencode/shared.js', () => ({
  readConfigLayers: () => ({ mergedConfig: {} }),
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
  it('surfaces legacy TOKENS_LIMIT and TIME_LIMIT quota windows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 100, nextResetTime: 1785659659993 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0, nextResetTime: 1787128459979 },
        ],
      },
    })));

    const result = await fetchQuota();
    const windows = result.usage.windows;

    expect(result.ok).toBe(true);
    expect(windows['5h']).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100,
      windowSeconds: 5 * 60 * 60,
      resetAt: null,
    });
    expect(windows.weekly).toMatchObject({
      usedPercent: 100,
      remainingPercent: 0,
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: 1785659659993,
    });
    expect(windows['MCP Tools']).toMatchObject({
      usedPercent: 0,
      remainingPercent: 100,
      windowSeconds: 30 * 24 * 60 * 60,
      resetAt: 1787128459979,
    });
  });

  it('maps CREDIT_LIMIT entries to windows with credit value labels and plan level', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      code: 200,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 65, remaining: 11934, percentage: 1, nextResetTime: 1787257978907 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 18624, remaining: 41375, percentage: 31, nextResetTime: 1787844668997 },
        ],
        level: 'pro',
      },
    })));

    const result = await fetchQuota();
    const windows = result.usage.windows;

    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('pro');
    expect(windows['5h']).toMatchObject({
      usedPercent: 1,
      remainingPercent: 99,
      windowSeconds: 5 * 60 * 60,
      resetAt: 1787257978907,
      valueLabel: '65 / 12k credits',
    });
    expect(windows.weekly).toMatchObject({
      usedPercent: 31,
      remainingPercent: 69,
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: 1787844668997,
      valueLabel: '18.6k / 60k credits',
    });
  });

  it('reports not configured without credentials', async () => {
    vi.doMock('../../opencode/auth.js', () => ({ readAuthFile: () => ({}) }));
    vi.resetModules();

    const { fetchQuota: isolatedFetchQuota } = await import('./zhipuai-coding-plan.js');
    const result = await isolatedFetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });
});
