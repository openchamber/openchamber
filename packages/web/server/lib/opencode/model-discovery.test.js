import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  test('presents the client certificate from its files and variables on an https endpoint only', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-mtls-'));
    try {
      // OpenCode trims what a file reference reads.
      await fs.writeFile(path.join(dir, 'client.pem'), 'CERT PEM\n');
      const models = () => new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      const withCertificate = vi.fn(async () => models());
      const plain = vi.fn(async () => models());
      const tls = { cert: `{file:${path.join(dir, 'client.pem')}}`, key: '{env:CLIENT_KEY}', passphrase: '{env:KEY_PASS}' };
      const options = { fetch: plain, fetchWithClientCertificate: withCertificate, env: { CLIENT_KEY: 'KEY PEM', KEY_PASS: 'pw' } };

      await discoverProviderModels({ baseURL: 'https://gw.test/v1', tls, enrich: false }, options);
      expect(withCertificate).toHaveBeenCalledWith(new URL('https://gw.test/v1/models'), expect.objectContaining({ redirect: 'manual' }),
        { cert: 'CERT PEM', key: 'KEY PEM', passphrase: 'pw' });
      expect(plain).not.toHaveBeenCalled();

      // A literal passphrase reaches the key as written.
      await discoverProviderModels({ baseURL: 'https://gw.test/v1', tls: { ...tls, passphrase: ' two words ' }, enrich: false }, options);
      expect(withCertificate.mock.lastCall?.[2]).toMatchObject({ passphrase: ' two words ' });

      // A certificate is presented only in a TLS handshake.
      await discoverProviderModels({ baseURL: 'http://gw.test/v1', tls, enrich: false }, options);
      expect(plain).toHaveBeenCalledTimes(1);

      await expect(discoverProviderModels({ baseURL: 'https://gw.test/v1', tls: { ...tls, cert: `{file:${path.join(dir, 'missing.pem')}}` } }, options))
        .rejects.toMatchObject({ statusCode: 400, code: 'client_certificate' });
      await expect(discoverProviderModels({ baseURL: 'https://gw.test/v1', tls: { cert: tls.cert } }, options))
        .rejects.toMatchObject({ statusCode: 400, code: 'client_certificate' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  test('resolves environment variables in stored keys', async () => {
    const requests = [];
    const fetchMock = async (_url, init) => {
      requests.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 });
    };

    await discoverProviderModels({ baseURL: 'https://provider.test', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: '{env:STORED_KEY}',
      storedBaseURL: 'https://provider.test',
      env: { STORED_KEY: 'resolved-secret' },
    });

    expect(requests).toEqual(['Bearer resolved-secret']);
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

  // vLLM-style `/models` entries name their fields `max_input_tokens`,
  // `input_modalities`, and `supports_tool_call`; the provider's own numbers
  // must survive discovery instead of being dropped for want of the
  // OpenAI-style names.
  test('reads a provider model described with vLLM-style field names', async () => {
    const result = await discoverProviderModels({ baseURL: 'https://provider.test', enrich: false }, {
      fetch: async () => new Response(JSON.stringify({ data: [
        {
          id: 'deepseek-v4.1-flash',
          max_input_tokens: 1_000_000,
          max_output_tokens: 128_000,
          input_modalities: ['text', 'image'],
          supports_tool_call: true,
        },
        { id: 'big-pickle', input_modalities: ['text'], supports_tool_call: false },
      ] }), { status: 200 }),
    });
    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'big-pickle',
        capabilities: { input: ['text'], output: ['text'], tools: false },
      }),
      expect.objectContaining({
        id: 'deepseek-v4.1-flash',
        limit: { context: 1_000_000, output: 128_000 },
        capabilities: { input: ['text', 'image'], output: ['text'], tools: true },
      }),
    ]);
  });
});