import { describe, expect, test } from 'bun:test';
import { getNextFavoriteModel, resolveModelRefs } from './modelRefs';

const model = (providerId: string, modelId: string) => ({
  id: `${providerId}/${modelId}`,
  modelID: modelId,
  providerID: providerId,
  name: modelId,
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [],
  time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: 'active' as const,
  enabled: true,
  limit: { context: 0, output: 0 },
});

const provider = (id: string, modelIds: string[]) => ({
  id,
  name: id,
  activation: 'enabled' as const,
  package: id,
  models: modelIds.map((modelId) => model(id, modelId)),
});

const ref = (providerID: string, modelID: string) => ({ providerID, modelID });

// The catalog after OpenAI was disconnected: its favorite stays stored.
const providers = [provider('anthropic', ['opus', 'sonnet', 'haiku'])];
const favorites = [ref('anthropic', 'opus'), ref('openai', 'gpt'), ref('anthropic', 'sonnet'), ref('anthropic', 'gone')];

describe('resolveModelRefs', () => {
  test('keeps the stored order and drops unknown providers, unknown models and hidden ones', () => {
    const resolved = resolveModelRefs(
      [...favorites, ref('anthropic', 'haiku')],
      providers,
      [ref('anthropic', 'haiku')],
    );
    expect(resolved.map(({ providerID, modelID }) => `${providerID}/${modelID}`)).toEqual([
      'anthropic/opus',
      'anthropic/sonnet',
    ]);
  });
});

describe('getNextFavoriteModel', () => {
  test('cycles forward and backward over resolvable favorites only', () => {
    expect(getNextFavoriteModel(favorites, providers, [], ref('anthropic', 'opus'), 1)).toEqual(ref('anthropic', 'sonnet'));
    expect(getNextFavoriteModel(favorites, providers, [], ref('anthropic', 'sonnet'), 1)).toEqual(ref('anthropic', 'opus'));
    expect(getNextFavoriteModel(favorites, providers, [], ref('anthropic', 'opus'), -1)).toEqual(ref('anthropic', 'sonnet'));
  });

  test('leaves an unavailable current model for the first available favorite', () => {
    expect(getNextFavoriteModel(favorites, providers, [], ref('openai', 'gpt'), 1)).toEqual(ref('anthropic', 'opus'));
  });

  test('returns null when no favorite resolves', () => {
    expect(getNextFavoriteModel([ref('openai', 'gpt')], providers, [], ref('anthropic', 'opus'), 1)).toBeNull();
    expect(getNextFavoriteModel(favorites, providers, favorites, ref('anthropic', 'opus'), 1)).toBeNull();
  });
});
