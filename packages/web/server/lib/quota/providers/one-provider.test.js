import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchQuota as fetchOneProviderQuota } from './one-provider.js';

const readCredentials = async () => ({
  'one-provider': { type: 'api', key: 'sk-test-one-provider' }
});
const fetchQuota = () => fetchOneProviderQuota({ readCredentials });

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Shape read live from https://api.oneprovider.dev/v1/usage on 2026-11-03.
const DOCUMENTED_PAYLOAD = {
  mode: 'quota_limited',
  isValid: true,
  status: 'active',
  planName: 'OneProvider',
  quota: { limit: 251.17663, used: 85.570136, remaining: 165.606494, unit: 'USD' },
  remaining: 165.606494,
  unit: 'USD',
  expires_at: '2027-01-31T23:58:40.857839+00:00',
  days_until_expiry: 89,
  usage: { today: { requests: 872, total_tokens: 88424251, cost: 85.570136 } }
};

describe('One Provider quota provider', () => {
  it('builds a credits_balance window from the USD remaining balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD)));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('one-provider');
    expect(result.providerName).toBe('One Provider');
    expect(result.planLabel).toBe('OneProvider');

    const balance = result.usage.windows.credits_balance;
    expect(balance).toBeDefined();
    expect(balance.valueLabel).toBe('$165.61');
    expect(balance.usedPercent).toBeNull();
    expect(balance.windowSeconds).toBeNull();
    expect(balance.resetAt).toBeNull();
  });

  it('builds a monthly window from spend against the allowance, resetting at expiry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD)));

    const result = await fetchQuota();

    const monthly = result.usage.windows.monthly;
    expect(monthly).toBeDefined();
    expect(monthly.usedPercent).toBe(34);
    expect(monthly.remainingPercent).toBe(66);
    expect(monthly.windowSeconds).toBe(30 * 24 * 60 * 60);
    expect(monthly.resetAt).toBe(DOCUMENTED_PAYLOAD.expires_at);
  });

  it('derives the spent amount when only limit and remaining are reported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      quota: { limit: 100, remaining: 25 }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.monthly.usedPercent).toBe(75);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$25.00');
  });

  it('tolerates numeric strings for money fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      quota: { limit: '251.17663', used: '85.570136', remaining: '165.606494' }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$165.61');
    expect(result.usage.windows.monthly.usedPercent).toBe(34);
  });

  it('keeps a literal zero balance as a valid valueLabel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      quota: { limit: 50, used: 50, remaining: 0 }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$0.00');
    expect(result.usage.windows.monthly.usedPercent).toBe(100);
  });

  it('reads an exhausted account as a successful sample, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      ...DOCUMENTED_PAYLOAD,
      isValid: false,
      status: 'expired'
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('drops the balance row when the amount is unusable instead of reporting $0.00', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      quota: { limit: 100, used: 10, remaining: 'n/a' }
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance).toBeUndefined();
    expect(result.usage.windows.monthly.usedPercent).toBe(10);
  });

  it('returns no-quota-data when neither a balance nor an allowance is usable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ mode: 'quota_limited' })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it('maps 401 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with One Provider');
  });

  it('maps 403 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.error).toBe('Session expired — please re-authenticate with One Provider');
  });

  it('reports a plain API error for other statuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.error).toBe('API error: 502');
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

  it('returns not-configured without a credential', async () => {
    const result = await fetchOneProviderQuota({ readCredentials: async () => ({}) });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it('sends the bearer token to the configured base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    await fetchQuota();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.oneprovider.dev/v1/usage');
    expect(init.headers.Authorization).toBe('Bearer sk-test-one-provider');
    expect(init.redirect).toBe('error');
  });
});
