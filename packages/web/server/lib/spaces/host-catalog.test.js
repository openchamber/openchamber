import { describe, expect, it } from 'vitest';

import { addressThroughWindow, catalogWindowOf, createHostCatalog, headerOfCatalogPackage } from './host-catalog.js';

// The host's catalog as OpenCode 2.3 lists it, trimmed to what the module reads.
const GO = { id: 'opencode-go', integrationID: 'opencode', name: 'OpenCode Go', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://opencode.ai/inference/go/openai/v1' }, headers: { 'x-opencode-org-id': 'wrk_1' } };
const ZAI = { id: 'zai-coding-plan', integrationID: 'zai-coding-plan', name: 'Z.AI Coding Plan', package: '@opencode/ai/providers/zai-coding-plan/chat', settings: { baseURL: 'https://api.z.ai/api/coding/paas/v4' } };
const ZEN = { id: 'opencode', integrationID: 'opencode', name: 'OpenCode', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://opencode.ai/inference/openai/v1' } };
const MIXED = { id: 'mixed', name: 'Mixed', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://mixed.example/openai/v1' } };
const model = (providerID, id, pkg, baseURL) => ({ providerID, id, package: pkg, settings: { baseURL } });
const MODELS = [
  model('opencode-go', 'deepseek-v4.1-flash', '@opencode/ai/providers/openai-compatible', 'https://opencode.ai/inference/go/openai/v1'),
  model('opencode-go', 'minimax-m3', '@opencode/ai/providers/anthropic', 'https://opencode.ai/inference/go/anthropic/v1'),
  model('opencode-go', 'gemini', '@opencode/ai/providers/google', 'https://opencode.ai/inference/go/google/v1beta'),
  model('zai-coding-plan', 'glm-5.3-flash', '@opencode/ai/providers/zai-coding-plan/chat', 'https://api.z.ai/api/coding/paas/v4'),
  model('opencode', 'big-pickle', '@opencode/ai/providers/openai-compatible', 'https://opencode.ai/inference/openai/v1'),
  model('mixed', 'a', '@opencode/ai/providers/openai-compatible', 'https://mixed.example/openai/v1'),
  model('mixed', 'b', '@opencode/ai/providers/anthropic', 'https://mixed.example/anthropic/v1'),
];
const catalog = (providers = [GO, ZAI, ZEN, MIXED]) => async () => ({ providers, models: MODELS });

describe('the host\'s catalog providers', () => {
  it('knows the header of each bundled package by its root, and none for one that signs its requests', () => {
    expect(headerOfCatalogPackage('@opencode/ai/providers/zai-coding-plan/chat')).toBe('authorization');
    expect(headerOfCatalogPackage('@opencode/ai/providers/anthropic')).toBe('x-api-key');
    expect(headerOfCatalogPackage('@opencode/ai/providers/google')).toBe('x-goog-api-key');
    expect(headerOfCatalogPackage('@opencode/ai/providers/amazon-bedrock')).toBeNull();
    expect(headerOfCatalogPackage('aisdk:@ai-sdk/openai')).toBeNull();
  });

  it('serves OpenCode Go through one bearer window above all of its routes, and every address keeps its path', async () => {
    const definition = await createHostCatalog({ readCatalog: catalog() }).read('opencode-go', '/p');
    expect(definition.window).toEqual({ upstream: 'https://opencode.ai/inference/go/', header: 'authorization' });
    expect(definition.integration).toBe('opencode');
    expect(addressThroughWindow('https://opencode.ai/inference/go/anthropic/v1', definition.window.upstream, 'http://gatekeeper:8080/model/opencode-go')).toBe('http://gatekeeper:8080/model/opencode-go/anthropic/v1');
    expect(addressThroughWindow('https://elsewhere.example/v1', definition.window.upstream, 'http://gatekeeper:8080/model/opencode-go')).toBeNull();
  });

  it('refuses a provider whose models read keys from different headers, and OpenCode\'s own', async () => {
    const hostCatalog = createHostCatalog({ readCatalog: catalog() });
    expect((await hostCatalog.read('mixed', '/p')).window).toBeNull();
    expect((await hostCatalog.read('opencode', '/p')).window).toBeNull();
    expect(await hostCatalog.read('missing', '/p')).toBeNull();
  });

  it('refuses an address that is not https or names credentials', () => {
    expect(catalogWindowOf({ id: 'x', package: '@opencode/ai/providers/openai-compatible', baseURL: 'http://10.0.0.5/v1', models: [] })).toBeNull();
    expect(catalogWindowOf({ id: 'x', package: '@opencode/ai/providers/openai-compatible', baseURL: 'https://user:pw@x.example/v1', models: [] })).toBeNull();
  });

  it('lists every provider with whether a grant serves it and whether a key is stored, never the key', async () => {
    const hostCatalog = createHostCatalog({ readCatalog: catalog(), readStoredKey: async (integration) => (integration === 'opencode' ? 'sk-go' : null) });
    const listed = await hostCatalog.list('/p');
    expect(listed).toEqual([
      { id: 'opencode-go', name: 'OpenCode Go', supported: true, storedKey: true },
      { id: 'zai-coding-plan', name: 'Z.AI Coding Plan', supported: true, storedKey: false },
      { id: 'opencode', name: 'OpenCode', supported: false, storedKey: true },
      { id: 'mixed', name: 'Mixed', supported: false, storedKey: false },
    ]);
    expect(JSON.stringify(listed)).not.toContain('sk-go');
  });

  it('fails when the host\'s OpenCode cannot be asked, rather than answering no providers', async () => {
    const hostCatalog = createHostCatalog({ readCatalog: async () => { throw new Error('OpenCode on this computer is not running'); } });
    await expect(hostCatalog.list('/p')).rejects.toThrow('not running');
  });
});
