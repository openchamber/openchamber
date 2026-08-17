import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ commandcode: { key: 'test-key' } }),
}));

import { fetchQuota } from './commandcode.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Verified real payload shape from https://api.commandcode.ai/alpha/billing/credits
const DOCUMENTED_PAYLOAD = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 60.507491674,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: {
      used: 9.492508326,
      cap: 14,
      exceeded: false,
      resetAt: 1786971142680,
    },
    weekly: {
      used: 9.492508326,
      cap: 35,
      exceeded: false,
      resetAt: 1787557942680,
    },
  },
};

describe('Command Code quota provider', () => {
  it('builds all three usage bars from the documented payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD)));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('commandcode');
    expect(result.configured).toBe(true);

    const { windows } = result.usage;
    expect(windows['5h']).toBeDefined();
    expect(windows['5h'].usedPercent).toBeCloseTo((9.492508326 / 14) * 100, 5);
    expect(windows['5h'].windowSeconds).toBe(5 * 60 * 60);
    expect(windows['5h'].resetAt).toBe(1786971142680);

    expect(windows.weekly).toBeDefined();
    expect(windows.weekly.usedPercent).toBeCloseTo((9.492508326 / 35) * 100, 5);
    expect(windows.weekly.windowSeconds).toBe(7 * 24 * 60 * 60);
    expect(windows.weekly.resetAt).toBe(1787557942680);

    expect(windows.credits_balance).toBeDefined();
    expect(windows.credits_balance.valueLabel).toBe('$60.51');
    expect(windows.credits_balance.usedPercent).toBeNull();
    expect(windows.credits_balance.windowSeconds).toBeNull();
    expect(windows.credits_balance.resetAt).toBeNull();
  });

  it('omits windows when resetAt is 0 (inactive window)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      credits: DOCUMENTED_PAYLOAD.credits,
      windowLimits: {
        limited: true,
        fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
        weekly: { used: 0, cap: 35, exceeded: false, resetAt: 0 },
      },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h']).toBeUndefined();
    expect(result.usage.windows.weekly).toBeUndefined();
    expect(result.usage.windows.credits_balance).toBeDefined();
  });

  it('degrades gracefully when limited is false (pay-as-you-go)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      credits: {
        monthlyCredits: 0,
        purchasedCredits: 25,
        freeCredits: 0,
      },
      windowLimits: {
        limited: false,
        exceeded: null,
      },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h']).toBeUndefined();
    expect(result.usage.windows.weekly).toBeUndefined();
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$25.00');
  });

  it('omits the balance row when the API reports no credits at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      credits: null,
      windowLimits: {
        limited: true,
        fiveHour: { used: 1, cap: 14, exceeded: false, resetAt: 1786971142680 },
        weekly: { used: 2, cap: 35, exceeded: false, resetAt: 1787557942680 },
      },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h']).toBeDefined();
    expect(result.usage.windows.weekly).toBeDefined();
    expect(result.usage.windows.credits_balance).toBeUndefined();
  });

  it('maps 401 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with Command Code');
  });

  it('maps 403 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with Command Code');
  });

  it('maps other API errors to API error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 500');
  });

  it('reports invalid-response on JSON parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid response from provider');
  });

  it('reports a normalized timeout error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request timed out');
  });
});
