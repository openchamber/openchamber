import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toClientModelsMetadata, MODELS_DEV_CATALOG_MAX_BYTES } from './models-metadata.js';

const catalog = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    npm: '@ai-sdk/openai',
    doc: 'https://example.test/docs',
    models: {
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT-5',
        tool_call: true,
        reasoning: true,
        attachment: true,
        temperature: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
        limit: { context: 400000, output: 128000 },
        knowledge: '2024-09',
        release_date: '2025-08-07',
        last_updated: '2025-08-07',
        open_weights: false,
        provider: { npm: '@ai-sdk/openai' },
      },
    },
  },
};

describe('toClientModelsMetadata', () => {
  it('keeps every field the UI reads and drops the rest', () => {
    const projected = toClientModelsMetadata(catalog);
    expect(projected).toEqual({
      openai: {
        id: 'openai',
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            tool_call: true,
            reasoning: true,
            attachment: true,
            temperature: false,
            modalities: { input: ['text', 'image'], output: ['text'] },
            cost: { input: 1.25, output: 10, cache_read: 0.125 },
            limit: { context: 400000, output: 128000 },
            knowledge: '2024-09',
            release_date: '2025-08-07',
            last_updated: '2025-08-07',
          },
        },
      },
    });
  });

  it('skips malformed providers and models instead of failing the route', () => {
    expect(toClientModelsMetadata({ broken: 'x', empty: { id: 'empty' }, odd: { models: { bad: 3 } } })).toEqual({
      odd: { models: {} },
    });
    expect(toClientModelsMetadata(null)).toEqual({});
  });

  it('projects one catalog object once', () => {
    expect(toClientModelsMetadata(catalog)).toBe(toClientModelsMetadata(catalog));
  });
});

describe('getModelsMetadata byte cap', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  const overCapResponse = () => new Response('{}', {
    status: 200,
    headers: { 'content-length': String(MODELS_DEV_CATALOG_MAX_BYTES + 1) },
  });

  it('parses a within-cap body', async () => {
    const { getModelsMetadata } = await import('./models-metadata.js');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(catalog), { status: 200 }));
    const result = await getModelsMetadata({ url: 'https://example.test/catalog.json', ttlMs: 0 });
    expect(result.fromCache).toBe(false);
    expect(result.metadata).toEqual(catalog);
  });

  it('throws on an over-cap body when no cache exists, caching nothing', async () => {
    const { getModelsMetadata } = await import('./models-metadata.js');
    vi.stubGlobal('fetch', async () => overCapResponse());
    await expect(getModelsMetadata({ url: 'https://example.test/catalog.json', ttlMs: 0 }))
      .rejects.toThrow(/size limit/);
    // Nothing partial was cached: a later within-cap fetch is fresh, not stale.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(catalog), { status: 200 }));
    const result = await getModelsMetadata({ url: 'https://example.test/catalog.json', ttlMs: 0 });
    expect(result.stale).toBeUndefined();
    expect(result.metadata).toEqual(catalog);
  });

  it('returns stale cache on an over-cap body like a fetch failure', async () => {
    const { getModelsMetadata } = await import('./models-metadata.js');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(catalog), { status: 200 }));
    await getModelsMetadata({ url: 'https://example.test/catalog.json', ttlMs: 0 });
    vi.stubGlobal('fetch', async () => overCapResponse());
    const result = await getModelsMetadata({ url: 'https://example.test/catalog.json', ttlMs: 0 });
    expect(result.stale).toBe(true);
    expect(result.metadata).toEqual(catalog);
  });
});

describe('peekModelsMetadata', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null before any fetch and never triggers one', async () => {
    const { peekModelsMetadata } = await import('./models-metadata.js');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(peekModelsMetadata()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the catalog a completed fetch cached', async () => {
    const { getModelsMetadata, peekModelsMetadata } = await import('./models-metadata.js');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(catalog), { status: 200 }));
    await getModelsMetadata({ url: 'https://example.test/catalog.json', ttlMs: 0 });
    expect(peekModelsMetadata()).toEqual(catalog);
  });
});
