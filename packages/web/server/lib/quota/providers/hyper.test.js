import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ hyper: { key: 'test-token' } }),
}));

import { fetchQuota } from './hyper.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Documented payload shape from https://hyper.charm.land/docs/api/credits.html
// The balance is denominated in Hypercredits; 1 credit = $0.05.
describe('Charm Hyper quota provider', () => {
  it('builds credits and credits_balance windows from documented payload (numeric balance)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ balance: 100 })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('hyper');

    const balanceWindow = result.usage.windows.credits_balance;
    expect(balanceWindow).toBeDefined();
    expect(balanceWindow.valueLabel).toBe('$5.00');
    expect(balanceWindow.usedPercent).toBeNull();
    expect(balanceWindow.windowSeconds).toBeNull();
    expect(balanceWindow.resetAt).toBeNull();

    const creditsWindow = result.usage.windows.credits;
    expect(creditsWindow).toBeDefined();
    expect(creditsWindow.valueLabel).toBe('100 credits');
    expect(creditsWindow.usedPercent).toBeNull();
    expect(creditsWindow.windowSeconds).toBeNull();
    expect(creditsWindow.resetAt).toBeNull();
  });

  it('tolerates a string balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ balance: '50' })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits.valueLabel).toBe('50 credits');
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$2.50');
  });

  it('formats a fractional balance in both windows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ balance: 25.5 })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits.valueLabel).toBe('25.50 credits');
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$1.28');
  });

  it('maps 401 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with Charm Hyper');
  });

  it('maps 403 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with Charm Hyper');
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

  it('returns no-quota-data on a 200 payload with no balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({})));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it('returns no-quota-data on an empty-string balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ balance: '' })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it('keeps a literal zero balance as a valid valueLabel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ balance: 0 })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits.valueLabel).toBe('0 credits');
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$0.00');
  });
});