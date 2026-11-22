import { afterEach, describe, expect, it, vi } from 'vitest';

const readAuth = async () => ({ 'zhipuai-coding-plan': { key: 'test-token' } });

import { fetchQuota, isConfigured } from './zhipuai-coding-plan.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('Zhipu AI Coding Plan quota provider', () => {
  it('maps CREDIT_LIMIT entries to 5-hour and weekly windows with credit labels and plan level', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      code: 200,
      msg: '操作成功',
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 900, remaining: 1100, percentage: 45, nextResetTime: 1797930060000 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 6000, remaining: 4000, percentage: 60, nextResetTime: 1798425600000 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 5, nextResetTime: 1798425600000 },
        ],
        level: 'lite',
      },
    })));

    const result = await fetchQuota({ readAuth });
    const windows = result.usage.windows;

    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('lite');
    expect(windows['5h']).toMatchObject({
      usedPercent: 45,
      remainingPercent: 55,
      windowSeconds: 5 * 60 * 60,
      resetAt: 1797930060000,
      valueLabel: '900 / 2k credits',
    });
    expect(windows.weekly).toMatchObject({
      usedPercent: 60,
      remainingPercent: 40,
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: 1798425600000,
      valueLabel: '6k / 10k credits',
    });
    expect(windows['MCP Tools']).toMatchObject({
      usedPercent: 5,
      windowSeconds: 30 * 24 * 60 * 60,
      resetAt: 1798425600000,
    });
  });

  it('still maps legacy TOKENS_LIMIT entries without credit labels', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 30 },
        ],
      },
    })));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h']).toMatchObject({
      usedPercent: 30,
      windowSeconds: 5 * 60 * 60,
    });
    expect(result.usage.windows['5h'].valueLabel).toBeUndefined();
  });

  it('derives the used percent from currentValue/usage when percentage is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 900 },
        ],
      },
    })));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(45);
    expect(result.usage.windows['5h'].valueLabel).toBe('900 / 2k credits');
  });

  it('clamps out-of-range percentages to [0, 100] on credit and MCP windows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 900, percentage: 150 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 6000, percentage: -20 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 150 },
        ],
      },
    })));

    const result = await fetchQuota({ readAuth });
    const windows = result.usage.windows;

    expect(result.ok).toBe(true);
    expect(windows['5h']).toMatchObject({ usedPercent: 100, remainingPercent: 0 });
    expect(windows.weekly).toMatchObject({ usedPercent: 0, remainingPercent: 100 });
    expect(windows['MCP Tools']).toMatchObject({ usedPercent: 100, remainingPercent: 0 });
  });

  it('clamps the derived currentValue/usage percentage to [0, 100] when percentage is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 200 },
        ],
      },
    })));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(100);
    expect(result.usage.windows['5h'].remainingPercent).toBe(0);
  });

  it('surfaces business failures reported inside HTTP 200 bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      code: 401,
      msg: '令牌已过期或验证不正确',
      success: false,
    })));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('令牌已过期或验证不正确');
    expect(result.usage).toBeNull();
  });

  it('fetches with the token when the key field is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({
      data: { limits: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth: async () => ({ 'zhipuai-coding-plan': { key: '', token: 'real-token' } }) });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer ' + 'real-token');
    expect(isConfigured({ 'zhipuai-coding-plan': { key: '', token: 'real-token' } })).toBe(true);
  });

  it('fetches with the token when the key field is whitespace-only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({
      data: { limits: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth: async () => ({ 'zhipuai-coding-plan': { key: '   ', token: 'real-token' } }) });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer ' + 'real-token');
    expect(isConfigured({ 'zhipuai-coding-plan': { key: '   ', token: 'real-token' } })).toBe(true);
  });

  it('fetches with the key when both key and token hold real values', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({
      data: { limits: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth: async () => ({ 'zhipuai-coding-plan': { key: 'real-key', token: 'real-token' } }) });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer ' + 'real-key');
    expect(isConfigured({ 'zhipuai-coding-plan': { key: 'real-key', token: 'real-token' } })).toBe(true);
  });

  it('reports not configured from both entry points when every field is empty', async () => {
    const entry = { key: '', token: '  ' };
    const result = await fetchQuota({ readAuth: async () => ({ 'zhipuai-coding-plan': entry }) });
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(isConfigured({ 'zhipuai-coding-plan': entry })).toBe(false);
  });

  it('falls back to the code when the envelope carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      code: 1001,
      success: false,
    })));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 1001');
  });
});

describe('Zhipu AI Coding Plan request deadline', () => {
  it('recognizes the timeout exception from AbortSignal.timeout', async () => {
    const fetchMock = vi.fn(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('Request timed out');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
