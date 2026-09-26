import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ deepinfra: { type: 'api', key: 'test-token' } }),
}));

import { fetchQuota } from './deepinfra.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Documented payload shape from https://docs.deepinfra.com/api-reference/account/me
// checklist.stripe_balance is negative when funds are ready to spend.
const DOCUMENTED_PAYLOAD = {
  uid: 'test-user',
  checklist: {
    stripe_balance: -50.75,
    recent: 29.44,
    limit: null,
  },
};

describe('DeepInfra quota provider', () => {
  it('builds credits_balance window from the documented negative stripe_balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD)));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('deepinfra');
    expect(result.providerName).toBe('DeepInfra');

    const window = result.usage.windows.credits_balance;
    expect(window).toBeDefined();
    expect(window.valueLabel).toBe('$50.75');
    expect(window.usedPercent).toBeNull();
    expect(window.windowSeconds).toBeNull();
    expect(window.resetAt).toBeNull();
  });

  it('keeps a literal zero balance as a valid valueLabel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      checklist: { stripe_balance: 0 },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$0.00');
  });

  it('renders money owed (positive stripe_balance) as a negative balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      checklist: { stripe_balance: 5.5 },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('-$5.50');
  });

  it('tolerates a numeric-string stripe_balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      checklist: { stripe_balance: '-12.5' },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$12.50');
  });

  it('maps 401 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with DeepInfra');
  });

  it('maps 403 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with DeepInfra');
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

  it('returns no-quota-data on a 200 payload with no usable balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ uid: 'test-user' })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });
});
