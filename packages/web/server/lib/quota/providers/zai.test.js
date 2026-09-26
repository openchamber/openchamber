import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ 'zai-coding-plan': { key: 'test-token' } }),
}));

import { fetchQuota, useZaiGiftReset } from './zai.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('Z.ai quota provider', () => {
  it('surfaces 5-hour, weekly, and MCP quota windows', async () => {
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
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 65, remaining: 59934, percentage: 1, nextResetTime: 1787844668997 },
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
      usedPercent: 1,
      remainingPercent: 99,
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: 1787844668997,
      valueLabel: '65 / 60k credits',
    });
  });

  it('attaches the nearest available gift reset to the matching windows', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 100, nextResetTime: 1785659659993 },
            { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0, nextResetTime: 1787128459979 },
          ],
        },
      }))
      .mockResolvedValueOnce(mockResponse({
        code: 200,
        success: true,
        data: {
          targetType: 'PERSONAL',
          fiveHourResets: [
            { recordId: 387233, expireTime: '2099-06-15 12:30:00', available: false },
            { recordId: 111111, expireTime: '2020-01-01 00:00:00', available: true },
            { recordId: 666002, expireTime: 'not-a-date', available: true },
            { recordId: 462029, expireTime: '2099-09-11 06:01:35', available: true },
            { recordId: 555501, expireTime: '2099-06-15 12:30:00', available: true },
          ],
          weekResets: [
            { recordId: 777003, expireTime: '2099-03-01 08:00:00', available: true },
          ],
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();
    const windows = result.usage.windows;

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL');
    expect(windows['5h'].giftReset).toEqual({
      recordId: 555501,
      expireAt: Date.parse('2099-06-15T12:30:00+08:00'),
    });
    expect(windows.weekly.giftReset).toEqual({
      recordId: 777003,
      expireAt: Date.parse('2099-03-01T08:00:00+08:00'),
    });
    expect(windows['MCP Tools'].giftReset).toBeUndefined();
  });

  it('keeps the quota result ok when the gift reset list request fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42 },
          ],
        },
      }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      }));

    const result = await fetchQuota();
    const windows = result.usage.windows;

    expect(result.ok).toBe(true);
    expect(windows['5h'].usedPercent).toBe(42);
    expect(windows['5h'].giftReset).toBeUndefined();
  });

  it('attaches no gift reset while only expired resets remain', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 10 },
          ],
        },
      }))
      .mockResolvedValueOnce(mockResponse({
        code: 200,
        success: true,
        data: {
          fiveHourResets: [
            { recordId: 111111, expireTime: '2020-01-01 00:00:00', available: true },
            { recordId: 999999, expireTime: '2099-01-01 00:00:00', available: false },
            { recordId: 222222, expireTime: '2026-01-01 00:00:00', available: true },
          ],
          weekResets: [],
        },
      })));

    const result = await fetchQuota();
    const windows = result.usage.windows;

    expect(result.ok).toBe(true);
    // Expired records carry no usable reset, so no button is attached.
    expect(windows['5h'].giftReset).toBeUndefined();
    expect(windows.weekly.giftReset).toBeUndefined();
  });

  it('attaches no gift reset for an expired unavailable record', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockResponse({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42 },
          ],
        },
      }))
      .mockResolvedValueOnce(mockResponse({
        code: 200,
        success: true,
        data: {
          // z.ai flips `available` to false once a record expires.
          fiveHourResets: [
            { recordId: 387233, expireTime: '2026-09-04 22:25:19', available: false },
          ],
          weekResets: [],
        },
      })));

    const result = await fetchQuota();
    const windows = result.usage.windows;

    expect(result.ok).toBe(true);
    expect(windows['5h'].giftReset).toBeUndefined();
  });
});

describe('Z.ai gift reset activation', () => {
  it('posts the activation request with a fresh requestId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({
      code: 200,
      msg: 'success',
      data: 462029,
      success: true,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(useZaiGiftReset({ recordId: 462029, resetType: 'FIVE_HOUR' })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.z.ai/api/biz/customer-package-reset/use');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      targetType: 'PERSONAL',
      resetType: 'FIVE_HOUR',
      recordId: 462029,
    });
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('throws the API message when activation is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 400, msg: 'reset already used', success: false }),
    }));

    await expect(useZaiGiftReset({ recordId: 1, resetType: 'WEEK' })).rejects.toThrow('reset already used');
  });

  it('rejects an invalid reset type before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(useZaiGiftReset({ recordId: 1, resetType: 'FOREVER' })).rejects.toThrow('Invalid gift reset request');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
