import { describe, expect, it } from 'vitest';
import { fetchQuota, isConfigured } from './kilo.js';

const readAuth = () => ({ kilo: { key: 'test-token' } });
const readOpencodeConfig = () => ({});

describe('Kilo Code quota provider', () => {
  it('builds credits_balance from the documented balance payload', async () => {
    let requests = 0;
    const result = await fetchQuota({
      readAuth,
      readOpencodeConfig,
      fetchImpl: async (url, options) => {
        requests += 1;
        expect(url).toBe('https://api.kilo.ai/api/profile/balance');
        expect(options.method).toBe('GET');
        const headers = new Headers(options.headers);
        expect(headers.get('Authorization')).toBe('Bearer test-token');
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get('x-kilocode-organizationid')).toBeNull();
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ balance: 12.5 });
      }
    });

    expect(requests).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('kilo');
    expect(result.configured).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$12.50');
    expect(result.usage.windows.credits_balance.usedPercent).toBeNull();
    expect(result.usage.windows.credits_balance.windowSeconds).toBeNull();
    expect(result.usage.windows.credits_balance.resetAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it.each([
    [0, '$0.00'],
    ['0', '$0.00'],
    [100, '$100.00'],
    ['3.5', '$3.50']
  ])('accepts finite balance %s', async (balance, label) => {
    const result = await fetchQuota({
      readAuth,
      readOpencodeConfig,
      fetchImpl: async () => Response.json({ balance })
    });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits_balance.valueLabel).toBe(label);
  });

  it.each([
    {}, null, [], { balance: '' }, { balance: ' \t ' }, { balance: 'NaN' },
    { balance: 'Infinity' }, { balance: null }, { balance: true }, { balance: [] },
    { balance: {} }
  ])('rejects invalid payload %j instead of showing zero', async (payload) => {
    const result = await fetchQuota({
      readAuth,
      readOpencodeConfig,
      fetchImpl: async () => Response.json(payload)
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
    expect(result.usage).toBeNull();
  });

  it.each([
    { kilo: { key: 'test-token' } },
    { kilo: { token: 'test-token' } },
    { kilo: { access: 'test-token' } },
    { kilo: 'test-token' },
    { kilocode: { key: 'test-token' } },
    { 'kilo-code': { key: 'test-token' } },
    { kilo: { key: '  ', token: 'test-token' } }
  ])('uses a validated credential for the documented request', async (auth) => {
    expect(isConfigured(auth)).toBe(true);
    let requests = 0;
    const result = await fetchQuota({
      readAuth: () => auth,
      readOpencodeConfig,
      fetchImpl: async (_url, options) => {
        requests += 1;
        expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
        return Response.json({ balance: 1 });
      }
    });

    expect(requests).toBe(1);
    expect(result.ok).toBe(true);
  });

  it.each([{}, { kilo: { key: '' } }, { kilo: { key: '  ' } }, { kilo: { key: 42 } }])(
    'does not request usage without a valid credential',
    async (auth) => {
      expect(isConfigured(auth)).toBe(false);
      let requests = 0;
      const result = await fetchQuota({
        readAuth: () => auth,
        readOpencodeConfig,
        fetchImpl: async () => {
          requests += 1;
          return Response.json({ balance: 1 });
        }
      });

      expect(requests).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(false);
      expect(result.error).toBe('Not configured');
    },
  );

  it('sends the organization header from the auth entry', async () => {
    const result = await fetchQuota({
      readAuth: () => ({ kilo: { key: 'test-token', organizationId: 'org-123' } }),
      readOpencodeConfig,
      fetchImpl: async (_url, options) => {
        expect(new Headers(options.headers).get('x-kilocode-organizationid')).toBe('org-123');
        return Response.json({ balance: 4 });
      }
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('org-123');
  });

  it('prefers the OAuth accountId over OpenCode config', async () => {
    const result = await fetchQuota({
      readAuth: () => ({ kilo: { type: 'oauth', access: 'test-token', accountId: 'oauth-org' } }),
      readOpencodeConfig: () => ({ provider: { kilo: { options: { kilocodeOrganizationId: 'config-org' } } } }),
      fetchImpl: async (_url, options) => {
        expect(new Headers(options.headers).get('x-kilocode-organizationid')).toBe('oauth-org');
        return Response.json({ balance: 4 });
      }
    });

    expect(result.ok).toBe(true);
  });

  it('falls back to OpenCode provider options when auth has no organization', async () => {
    const result = await fetchQuota({
      readAuth,
      readOpencodeConfig: () => ({ provider: { kilo: { options: { kilocodeOrganizationId: 'config-org' } } } }),
      fetchImpl: async (_url, options) => {
        expect(new Headers(options.headers).get('x-kilocode-organizationid')).toBe('config-org');
        return Response.json({ balance: 4 });
      }
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('config-org');
  });

  it.each([
    [401, 'Session expired — please re-authenticate with Kilo Code'],
    [403, 'Session expired — please re-authenticate with Kilo Code'],
    [429, 'API error: 429'],
    [500, 'API error: 500']
  ])('reports HTTP %s as a failure', async (status, error) => {
    const result = await fetchQuota({
      readAuth,
      readOpencodeConfig,
      fetchImpl: async () => new Response(null, { status })
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe(error);
    expect(result.usage).toBeNull();
  });

  it('reports invalid JSON as a parse failure', async () => {
    const result = await fetchQuota({
      readAuth,
      readOpencodeConfig,
      fetchImpl: async () => new Response('{')
    });
    expect(result.error).toBe('Invalid response from provider');
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
  });

  it.each([
    [new DOMException('Timed out', 'TimeoutError'), 'Request timed out'],
    [new Error('Network unavailable'), 'Network unavailable']
  ])('reports request failure', async (failure, message) => {
    const result = await fetchQuota({
      readAuth,
      readOpencodeConfig,
      fetchImpl: async () => { throw failure; }
    });
    expect(result.error).toBe(message);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
  });
});
