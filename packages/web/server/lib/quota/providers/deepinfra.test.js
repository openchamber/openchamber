import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPrices as fetchDeepinfraPrices, fetchQuota as fetchDeepinfraQuota } from './deepinfra.js';

const readCredentials = async () => ({ deepinfra: { type: 'api', key: 'test-token' } });
const fetchQuota = () => fetchDeepinfraQuota({ readCredentials });

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

  it('treats a blank balance as missing data, not as $0.00', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({
      checklist: { stripe_balance: '' },
    })));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No quota data in response');
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

// Documented shape of GET https://api.deepinfra.com/v1/models: each entry
// carries metadata.pricing per million tokens and metadata.discount as the
// share taken off (0.51 = 51 % off), which the pricing page shows as a struck
// through list price beside the campaign price.
const modelEntry = (id, pricing, discount) => ({
  id,
  object: 'model',
  metadata: { pricing, ...(discount === undefined ? {} : { discount }) },
});

const TOKEN_PRICING = { input_tokens: 0.2, output_tokens: 0.6, cache_read_tokens: 0.006 };

describe('DeepInfra model prices', () => {
  const fetchPrices = (modelIds, fetchImpl = vi.fn()) => fetchDeepinfraPrices({ modelIds, readCredentials, fetchImpl });

  it('takes the campaign discount off input, output and the cached read', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({
      data: [modelEntry('deepseek-ai/DeepSeek-V4.1-Flash-1017', TOKEN_PRICING, 0.51)],
    }));

    const costs = await fetchPrices(['deepseek-ai/DeepSeek-V4.1-Flash-1017'], fetchImpl);

    expect(costs).toEqual({
      'deepseek-ai/DeepSeek-V4.1-Flash-1017': { input: 0.098, output: 0.294, cache_read: 0.00294 },
    });
  });

  it('keeps the list price when the provider reports no campaign', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({
      data: [modelEntry('deepseek-ai/DeepSeek-V4.1-Flash', TOKEN_PRICING, null)],
    }));

    const costs = await fetchPrices(['deepseek-ai/DeepSeek-V4.1-Flash'], fetchImpl);

    expect(costs).toEqual({
      'deepseek-ai/DeepSeek-V4.1-Flash': { input: 0.2, output: 0.6, cache_read: 0.006 },
    });
  });

  it('prices only the configured models and skips models without token pricing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({
      data: [
        modelEntry('deepseek-ai/DeepSeek-V4.1-Flash-1017', TOKEN_PRICING, 0.51),
        modelEntry('other/model', TOKEN_PRICING, 0.51),
        modelEntry('image/model', { image_tokens: 1 }, 0.2),
      ],
    }));

    const costs = await fetchPrices(['deepseek-ai/DeepSeek-V4.1-Flash-1017'], fetchImpl);

    expect(Object.keys(costs)).toEqual(['deepseek-ai/DeepSeek-V4.1-Flash-1017']);
  });

  it('asks the provider nothing without a configured model', async () => {
    const fetchImpl = vi.fn();

    expect(await fetchPrices([], fetchImpl)).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a failing model list as an error the caller can ignore', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    await expect(fetchPrices(['deepseek-ai/DeepSeek-V4.1-Flash-1017'], fetchImpl))
      .rejects.toThrow('DeepInfra model list: 503');
  });
});
