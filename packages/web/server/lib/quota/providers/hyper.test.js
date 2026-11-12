import { describe, expect, it } from 'vitest';
import { fetchQuota, isConfigured } from './hyper.js';

const readAuth = () => ({ hyper: { key: 'test-token' } });

// https://hyper.charm.land/docs/api/credits.html documents the balance payload.
// https://hyper.charm.land/faq defines one Hypercredit as $0.05.
describe('Charm Hyper quota provider', () => {
  it.each([
    [100, '100', '$5.00'],
    ['50', '50', '$2.50'],
    [25.5, '25.50', '$1.28'],
    [0, '0', '$0.00'],
    ['0', '0', '$0.00'],
  ])('formats balance %s without an untranslated unit', async (balance, credits, dollars) => {
    const result = await fetchQuota({
      readAuth,
      fetchImpl: async () => Response.json({ balance }),
    });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('hyper');
    expect(result.configured).toBe(true);
    expect(result.usage.windows.credits.valueLabel).toBe(credits);
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
    { hyper: { key: 'test-token' } },
    { hyper: { token: 'test-token' } },
    { hyper: 'test-token' },
    { hyper: { key: '  ', token: 'test-token' } },
    { hyper: { key: 42, token: 'test-token' } },
  ])('uses a validated credential for the documented request', async (auth) => {
    expect(isConfigured(auth)).toBe(true);
    let requests = 0;
    const result = await fetchQuota({
      readAuth: () => auth,
      fetchImpl: async (url, options) => {
        requests += 1;
        expect(url).toBe('https://hyper.charm.land/v1/credits');
        expect(options.method).toBe('GET');
        expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ balance: 100 });
      },
    });

    expect(requests).toBe(1);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it.each([{}, { hyper: { key: '' } }, { hyper: { key: '  ' } }, { hyper: { key: 42 } }])(
    'does not request usage without a valid credential',
    async (auth) => {
      expect(isConfigured(auth)).toBe(false);
      let requests = 0;
      const result = await fetchQuota({
        readAuth: () => auth,
        fetchImpl: async () => {
          requests += 1;
          return Response.json({ balance: 100 });
        },
      });

      expect(requests).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(false);
      expect(result.error).toBe('Not configured');
    },
  );

  it.each([
    [401, 'Session expired — please re-authenticate with Charm Hyper'],
    [403, 'Session expired — please re-authenticate with Charm Hyper'],
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
