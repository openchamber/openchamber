import { describe, expect, it } from 'vitest';
import { fetchQuota, isConfigured } from './anymodel.js';

const readAuth = () => ({ anymodel: { key: 'test-token' } });

// https://anymodel.org/api-docs.md documents the balance payload; the FAQ
// defines one million balance tokens as $0.05.
describe('AnyModel quota provider', () => {
  it.each([
    [4200000, '4,200,000', '$0.21'],
    ['4200000', '4,200,000', '$0.21'],
    [0, '0', '$0.00'],
    ['0', '0', '$0.00'],
    [25.5, '25.5', '$0.00'],
    [20000000, '20,000,000', '$1.00'],
  ])('formats balance %s as tokens and dollars', async (balance, tokens, dollars) => {
    const result = await fetchQuota({
      readAuth,
      fetchImpl: async () => Response.json({ balance }),
    });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('anymodel');
    expect(result.configured).toBe(true);
    expect(result.usage.windows.tokens.valueLabel).toBe(tokens);
    expect(result.usage.windows.credits_balance.valueLabel).toBe(dollars);
    for (const window of Object.values(result.usage.windows)) {
      expect(window.usedPercent).toBeNull();
      expect(window.remainingPercent).toBeNull();
      expect(window.windowSeconds).toBeNull();
      expect(window.resetAt).toBeNull();
      expect(window.resetAfterSeconds).toBeNull();
    }
  });

  it.each([
    { unlimited: true },
    { unlimited: true, balance: 0 },
    { unlimited: true, balance: 'nonsense' },
  ])('reports an unlimited key as Unlimited without numbers', async (payload) => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => Response.json(payload) });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows.tokens).toBeUndefined();
    expect(result.usage.windows.credits_balance.valueLabel).toBe('Unlimited');
    expect(result.usage.windows.credits_balance.usedPercent).toBeNull();
  });

  it.each([
    {}, null, [], { balance: '' }, { balance: ' \t ' }, { balance: 'NaN' },
    { balance: 'Infinity' }, { balance: null }, { balance: true }, { balance: [] },
    { balance: {} },
  ])('rejects invalid payload %j instead of showing zero', async (payload) => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => Response.json(payload) });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it.each([
    { anymodel: { key: 'test-token' } },
    { anymodel: { token: 'test-token' } },
    { anymodel: 'test-token' },
    { anymodel: { key: '  ', token: 'test-token' } },
    { anymodel: { key: 42, token: 'test-token' } },
  ])('uses a validated credential for the documented request', async (auth) => {
    expect(isConfigured(auth)).toBe(true);
    let requests = 0;
    const result = await fetchQuota({
      readAuth: () => auth,
      fetchImpl: async (url, options) => {
        requests += 1;
        expect(url).toBe('https://anymodel.org/v1/balance');
        expect(options.method).toBe('GET');
        expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
        expect(options.redirect).toBe('error');
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ balance: 4200000 });
      },
    });

    expect(requests).toBe(1);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it.each([{}, { anymodel: { key: '' } }, { anymodel: { key: '  ' } }, { anymodel: { key: 42 } }])(
    'does not request usage without a valid credential',
    async (auth) => {
      expect(isConfigured(auth)).toBe(false);
      let requests = 0;
      const result = await fetchQuota({
        readAuth: () => auth,
        fetchImpl: async () => {
          requests += 1;
          return Response.json({ balance: 4200000 });
        },
      });

      expect(requests).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(false);
      expect(result.error).toBe('Not configured');
    },
  );

  it.each([
    [401, 'Session expired — please re-authenticate with AnyModel'],
    [403, 'Session expired — please re-authenticate with AnyModel'],
    [429, 'API error: 429'],
    [500, 'API error: 500'],
  ])('reports HTTP %s as a failure', async (status, error) => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => new Response(null, { status }) });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe(error);
    expect(result.usage).toBeNull();
  });

  it('reports invalid JSON as a parse failure', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => new Response('{') });
    expect(result.error).toBe('Invalid response from provider');
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
  });

  it.each([
    [new DOMException('Timed out', 'TimeoutError'), 'Request timed out'],
    [new Error('Network unavailable'), 'Network unavailable'],
  ])('reports request failure', async (failure, message) => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => { throw failure; } });
    expect(result.error).toBe(message);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
  });
});
