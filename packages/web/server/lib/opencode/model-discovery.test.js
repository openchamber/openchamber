import { describe, expect, test, vi } from 'vitest';
import { discoverProviderModels, modelDiscoveryInternals } from './model-discovery.js';

describe('provider model discovery', () => {
  test('builds the models URL from the configured base path', () => {
    expect(modelDiscoveryInternals.buildModelsUrl('http://localhost:11434/v1/', '/models').href)
      .toBe('http://localhost:11434/v1/models');
    expect(() => modelDiscoveryInternals.buildModelsUrl('file:///tmp/models', '/models')).toThrow('http or https');
    expect(() => modelDiscoveryInternals.buildModelsUrl('https://example.test/v1', 'https://evil.test/models')).toThrow('one slash');
  });

  test('filters transport headers and owns authorization', () => {
    expect(modelDiscoveryInternals.buildHeaders(
      { Host: 'evil.test', 'X-Tenant': '{env:TENANT}', Authorization: 'wrong' },
      'secret',
      { TENANT: 'one' },
    )).toEqual({ Accept: 'application/json', 'X-Tenant': 'one', Authorization: 'Bearer secret' });
  });

  test('discovers, deduplicates, and enriches an exact model match', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'gpt-test', name: 'Provider name', context_window: 64_000 },
      { id: 'gpt-test' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await discoverProviderModels({
      baseURL: 'https://provider.test/v1',
      apiKey: '{env:TEST_KEY}',
      enrich: true,
      metadataProviderID: 'openai',
    }, {
      fetch: fetchMock,
      env: { TEST_KEY: 'secret' },
      getModelsMetadata: async () => ({ metadata: {
        openai: { models: { 'gpt-test': {
          name: 'Catalog name',
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 128_000, output: 16_000 },
        } } },
      } }),
    });

    expect(fetchMock).toHaveBeenCalledWith(new URL('https://provider.test/v1/models'), expect.objectContaining({
      redirect: 'manual',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret' },
    }));
    expect(result.models).toEqual([expect.objectContaining({
      id: 'gpt-test',
      name: 'Provider name',
      limit: { context: 64_000 },
      metadataMatch: 'exact',
      metadata: expect.objectContaining({
        providerID: 'openai',
        limit: { context: 128_000, output: 16_000 },
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      }),
    })]);
  });

  test('keeps discovery successful when models.dev fails', async () => {
    const result = await discoverProviderModels({ baseURL: 'https://provider.test', enrich: true }, {
      fetch: async () => new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 }),
      getModelsMetadata: async () => { throw new Error('offline'); },
    });
    expect(result).toEqual({
      models: [{ id: 'local', name: 'local', metadataMatch: 'unavailable' }],
      enrichment: { requested: true, available: false },
    });
  });

  test('uses a stored key only when the request does not supply one', async () => {
    const requests = [];
    const fetchMock = async (_url, init) => {
      requests.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 });
    };

    await discoverProviderModels({ baseURL: 'https://provider.test', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: 'stored-key',
      storedBaseURL: 'https://provider.test/',
    });
    await discoverProviderModels({ baseURL: 'https://provider.test', apiKey: 'replacement-key', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: 'stored-key',
      storedBaseURL: 'https://provider.test',
    });

    expect(requests).toEqual(['Bearer stored-key', 'Bearer replacement-key']);
  });

  test('never sends the stored key to a base URL other than the saved one', async () => {
    const requests = [];
    const fetchMock = async (_url, init) => {
      requests.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 });
    };

    await discoverProviderModels({ baseURL: 'https://elsewhere.test', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: 'stored-key',
      storedBaseURL: 'https://provider.test',
    });
    await discoverProviderModels({ baseURL: 'https://provider.test/v1', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: 'stored-key',
    });

    expect(requests).toEqual([undefined, undefined]);
  });

  test('offers normalized matches as suggestions instead of applying them', async () => {
    const result = await discoverProviderModels({ baseURL: 'https://provider.test', enrich: true }, {
      fetch: async () => new Response(JSON.stringify({ data: [{ id: 'openai/gpt-test-production' }] }), { status: 200 }),
      getModelsMetadata: async () => ({ metadata: {
        openai: { models: { 'gpt-test': { limit: { context: 64_000 } } } },
        azure: { models: { 'gpt-test': { limit: { context: 32_000 } } } },
      } }),
    });
    expect(result.models[0]).toEqual(expect.objectContaining({
      metadataMatch: 'ambiguous',
      metadataCandidates: [
        expect.objectContaining({ providerID: 'openai', modelID: 'gpt-test' }),
        expect.objectContaining({ providerID: 'azure', modelID: 'gpt-test' }),
      ],
    }));
    expect(result.models[0].metadata).toBeUndefined();
  });
});