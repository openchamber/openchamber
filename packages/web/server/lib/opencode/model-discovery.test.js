import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

const mockDnsLookup = vi.fn();

vi.mock('node:dns', () => ({
  promises: {
    lookup: mockDnsLookup,
  },
}));

describe('model-discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn();
    mockDnsLookup.mockReset().mockResolvedValue([
      { address: '93.184.216.34', family: 4 }, // example.com public IP
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  const originalFetch = globalThis.fetch;

  const mockFetch = (response, status = 200, headers = {}) => {
    globalThis.fetch.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: {
        get: (name) => headers[name.toLowerCase()] || null,
      },
      json: async () => response,
      text: async () => JSON.stringify(response),
    });
  };

  const mockFetchError = (error) => {
    globalThis.fetch.mockRejectedValue(error);
  };

  describe('discoverModels', () => {
    it('returns normalized models on success', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({
        object: 'list',
        data: [
          { id: 'gpt-5', object: 'model' },
          { id: 'gpt-5-mini', object: 'model' },
        ],
      });

      const result = await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      });

      expect(result.models).toEqual([
        { id: 'gpt-5', name: 'gpt-5' },
        { id: 'gpt-5-mini', name: 'gpt-5-mini' },
      ]);
    });

    it('uses name field when provided', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({
        object: 'list',
        data: [
          { id: 'gpt-5', name: 'GPT-5', object: 'model' },
          { id: 'gpt-5-mini', name: 'GPT-5 Mini', object: 'model' },
        ],
      });

      const result = await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      });

      expect(result.models).toEqual([
        { id: 'gpt-5', name: 'GPT-5' },
        { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      ]);
    });

    it('returns empty array for empty data', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({ object: 'list', data: [] });

      const result = await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      });

      expect(result.models).toEqual([]);
    });

    it('deduplicates models by id', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({
        object: 'list',
        data: [
          { id: 'gpt-5', object: 'model' },
          { id: 'gpt-5', object: 'model' },
          { id: 'gpt-5-mini', object: 'model' },
        ],
      });

      const result = await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      });

      expect(result.models).toEqual([
        { id: 'gpt-5', name: 'gpt-5' },
        { id: 'gpt-5-mini', name: 'gpt-5-mini' },
      ]);
    });

    it('skips items without id', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({
        object: 'list',
        data: [
          { id: 'gpt-5', object: 'model' },
          { object: 'model' },
          { id: '', object: 'model' },
          { id: 'gpt-5-mini', object: 'model' },
        ],
      });

      const result = await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      });

      expect(result.models).toEqual([
        { id: 'gpt-5', name: 'gpt-5' },
        { id: 'gpt-5-mini', name: 'gpt-5-mini' },
      ]);
    });

    it('throws AUTH_FAILED on 401', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      mockFetch({ error: 'Unauthorized' }, 401);

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-invalid' })).rejects.toMatchObject({
        code: 'AUTH_FAILED',
        statusCode: 401,
        message: 'Authentication failed. Please check your API key.',
      });
    });

    it('throws ACCESS_DENIED on 403', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      mockFetch({ error: 'Forbidden' }, 403);

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
        statusCode: 403,
      });
    });

    it('throws ENDPOINT_NOT_FOUND on 404', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      mockFetch({ error: 'Not Found' }, 404);

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'ENDPOINT_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('throws TIMEOUT on request timeout', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      const timeoutError = new Error('AbortError');
      timeoutError.name = 'AbortError';
      mockFetchError(timeoutError);

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'TIMEOUT',
        statusCode: 504,
      });
    });

    it('throws NETWORK_ERROR on connection failure', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      mockFetchError(new Error('ENOTFOUND'));

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        statusCode: 502,
      });
    });

    it('throws INVALID_RESPONSE for missing data array', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      mockFetch({ models: [] });

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        statusCode: 400,
      });
    });

    it('throws INVALID_RESPONSE for non-array data', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      mockFetch({ data: 'not-an-array' });

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        statusCode: 400,
      });
    });

    it('throws INVALID_RESPONSE for invalid JSON', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      globalThis.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new Error('Invalid JSON'); },
      });

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        statusCode: 400,
      });
    });
  });

  describe('validateBaseURL (SSRF protection)', () => {
    it('rejects HTTP URLs', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      await expect(discoverModels({ baseURL: 'http://example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'INVALID_URL',
        statusCode: 400,
      });
    });

    it('rejects localhost', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      await expect(discoverModels({ baseURL: 'https://localhost:4000/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });
    });

    it('rejects 127.0.0.1', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      await expect(discoverModels({ baseURL: 'https://127.0.0.1:4000/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });
    });

    it('rejects 10.x.x.x private IPs', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      await expect(discoverModels({ baseURL: 'https://10.0.0.1/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });
    });

    it('rejects 172.16.x.x - 172.31.x.x private IPs', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      await expect(discoverModels({ baseURL: 'https://172.16.0.1/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });

      await expect(discoverModels({ baseURL: 'https://172.31.255.255/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });
    });

    it('rejects 192.168.x.x private IPs', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      await expect(discoverModels({ baseURL: 'https://192.168.1.1/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });
    });

    it('rejects 169.254.x.x link-local', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      await expect(discoverModels({ baseURL: 'https://169.254.169.254/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });
    });

    it('rejects metadata endpoint 169.254.169.254', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      await expect(discoverModels({ baseURL: 'https://169.254.169.254/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });
    });

    it('allows valid public HTTPS URLs', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] });

      const result = await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      });

      expect(result.models).toEqual([{ id: 'gpt-5', name: 'gpt-5' }]);
    });

    it('allows valid public HTTPS URLs with custom ports', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] });

      const result = await discoverModels({
        baseURL: 'https://api.example.com:8443/v1',
        apiKey: 'sk-test',
      });

      expect(result.models).toEqual([{ id: 'gpt-5', name: 'gpt-5' }]);
    });
  });

  describe('auth headers', () => {
    it('includes Authorization header with apiKey', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] });

      await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test123',
      });

      const call = globalThis.fetch.mock.calls[0];
      expect(call[1].headers.Authorization).toBe('Bearer sk-test123');
    });

    it('includes custom headers', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] });

      await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        headers: { 'X-Custom': 'value' },
      });

      const call = globalThis.fetch.mock.calls[0];
      expect(call[1].headers['X-Custom']).toBe('value');
    });

    it('does not include Authorization when apiKey is empty', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      mockFetch({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] });

      await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: '',
      });

      const call = globalThis.fetch.mock.calls[0];
      expect(call[1].headers.Authorization).toBeUndefined();
    });
  });

  describe('redirect handling', () => {
    it('follows redirects and re-validates', async () => {
      const { discoverModels } = await import('./model-discovery.js');

      globalThis.fetch
        .mockResolvedValueOnce({
          ok: true,
          status: 302,
          headers: { get: (name) => name.toLowerCase() === 'location' ? 'https://api.other.com/v1/models' : null },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] }),
        });

      const result = await discoverModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      });

      expect(result.models).toEqual([{ id: 'gpt-5', name: 'gpt-5' }]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('blocks redirect to private IP', async () => {
      const { discoverModels, DiscoveryError } = await import('./model-discovery.js');

      globalThis.fetch.mockResolvedValue({
        ok: true,
        status: 302,
        headers: { get: (name) => name.toLowerCase() === 'location' ? 'https://10.0.0.1/v1/models' : null },
      });

      await expect(discoverModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' })).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        statusCode: 400,
      });
    });
  });
});