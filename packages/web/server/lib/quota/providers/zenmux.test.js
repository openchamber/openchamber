import { describe, expect, it } from 'vitest';
import { fetchQuota, isConfigured } from './zenmux.js';

const readCredential = () => ({ platformApiKey: 'test-token' });

// https://zenmux.ai/docs/api/platform/payg-balance.html documents the PAYG balance payload.
const documentedPayload = {
  success: true,
  data: {
    currency: 'usd',
    total_credits: 482.74,
    top_up_credits: 35.0,
    bonus_credits: 447.74
  }
};

describe('ZenMux quota provider', () => {
  it('builds credits_balance from the documented PAYG payload', async () => {
    let requests = 0;
    const result = await fetchQuota({
      readCredential,
      fetchImpl: async (url, options) => {
        requests += 1;
        expect(url).toBe('https://zenmux.ai/api/v1/management/payg/balance');
        expect(options.method).toBe('GET');
        expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return Response.json(documentedPayload);
      }
    });

    expect(requests).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('zenmux');
    expect(result.configured).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$482.74');
    expect(result.usage.windows.credits_balance.usedPercent).toBeNull();
    expect(result.usage.windows.credits_balance.windowSeconds).toBeNull();
    expect(result.usage.windows.credits_balance.resetAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it.each([
    [0, '$0.00'],
    ['0', '$0.00'],
    [12.5, '$12.50'],
    ['3.5', '$3.50']
  ])('accepts finite total_credits %s', async (totalCredits, label) => {
    const result = await fetchQuota({
      readCredential,
      fetchImpl: async () => Response.json({ success: true, data: { currency: 'usd', total_credits: totalCredits } })
    });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe(label);
  });

  it.each([
    {}, null, [], { success: true }, { success: true, data: null },
    { success: true, data: {} }, { success: true, data: { total_credits: '' } },
    { success: true, data: { total_credits: ' \t ' } }, { success: true, data: { total_credits: 'NaN' } },
    { success: true, data: { total_credits: 'Infinity' } }, { success: true, data: { total_credits: null } },
    { success: true, data: { total_credits: true } }, { success: true, data: { total_credits: [] } },
    { success: true, data: { total_credits: {} } }
  ])('rejects invalid payload %j instead of showing zero', async (payload) => {
    const result = await fetchQuota({ readCredential, fetchImpl: async () => Response.json(payload) });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it.each([
    { platformApiKey: 'test-token' },
    { platformApiKey: ' test-token ' }
  ])('uses a validated Platform API key for the documented request', async (credential) => {
    expect(isConfigured(() => credential)).toBe(true);
    let requests = 0;
    const result = await fetchQuota({
      readCredential: () => credential,
      fetchImpl: async (_url, options) => {
        requests += 1;
        expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
        return Response.json(documentedPayload);
      }
    });

    expect(requests).toBe(1);
    expect(result.ok).toBe(true);
  });

  it.each([
    null,
    {},
    { platformApiKey: '' },
    { platformApiKey: '  ' },
    { platformApiKey: 42 },
    { key: 'test-token' },
    { token: 'test-token' }
  ])('does not request usage without a Platform API key %j', async (credential) => {
    expect(isConfigured(() => credential)).toBe(false);
    let requests = 0;
    const result = await fetchQuota({
      readCredential: () => credential,
      fetchImpl: async () => {
        requests += 1;
        return Response.json(documentedPayload);
      }
    });

    expect(requests).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it.each([
    [401, 'Invalid ZenMux Platform API key'],
    [403, 'Invalid ZenMux Platform API key'],
    [422, 'API error: 422'],
    [429, 'API error: 429'],
    [500, 'API error: 500']
  ])('reports HTTP %s as a failure', async (status, error) => {
    const result = await fetchQuota({ readCredential, fetchImpl: async () => new Response(null, { status }) });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe(error);
    expect(result.usage).toBeNull();
  });

  it('reports invalid JSON as a parse failure', async () => {
    const result = await fetchQuota({ readCredential, fetchImpl: async () => new Response('{') });
    expect(result.error).toBe('Invalid response from provider');
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
  });

  it.each([
    [new DOMException('Timed out', 'TimeoutError'), 'Request timed out'],
    [new Error('Network unavailable'), 'Network unavailable']
  ])('reports request failure', async (failure, message) => {
    const result = await fetchQuota({ readCredential, fetchImpl: async () => { throw failure; } });
    expect(result.error).toBe(message);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
  });
});
