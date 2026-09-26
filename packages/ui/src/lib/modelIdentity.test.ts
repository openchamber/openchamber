import { describe, expect, test } from 'bun:test';
import { findCatalogModel } from './modelIdentity';

const models = [
  { id: 'gpt-6-luna-fast', modelID: 'gpt-6-luna', providerID: 'openai' },
  { id: 'gpt-6-luna', modelID: 'gpt-6-luna', providerID: 'openai' },
];

describe('findCatalogModel', () => {
  test('matches an exact catalog id before a shared Fast modelID', () => {
    expect(findCatalogModel(models, 'gpt-6-luna')).toBe(models[1]);
    expect(findCatalogModel(models, 'gpt-6-luna-fast')).toBe(models[0]);
  });

  test('accepts a saved bare id for a provider-qualified catalog', () => {
    const qualified = models.map((model) => ({ ...model, id: `openai/${model.id}` }));
    expect(findCatalogModel(qualified, 'gpt-6-luna')).toBe(qualified[1]);
    expect(findCatalogModel(qualified, 'gpt-6-luna-fast')).toBe(qualified[0]);
    expect(findCatalogModel(qualified, 'openai/gpt-6-luna-fast')).toBe(qualified[0]);
  });

  test('resolves older qualified references without stripping arbitrary prefixes', () => {
    expect(findCatalogModel(models, 'openai/gpt-6-luna')).toBe(models[1]);
    expect(findCatalogModel(models, 'openai/gpt-6-luna-fast')).toBe(models[0]);
    expect(findCatalogModel(models, 'github-copilot/gpt-6-luna')).toBeUndefined();
    const slash = { id: 'vendor/model', modelID: 'upstream', providerID: 'proxy' };
    expect(findCatalogModel([slash], 'proxy/vendor/model')).toBe(slash);
    expect(findCatalogModel([slash], 'model')).toBeUndefined();
  });

  test('does not guess when multiple aliases match no exact or qualified id', () => {
    const ambiguous = models.map((model) => ({ ...model, id: `alias-${model.id}` }));
    expect(findCatalogModel(ambiguous, 'gpt-6-luna')).toBeUndefined();
    expect(findCatalogModel(models, 'missing')).toBeUndefined();
    expect(findCatalogModel(undefined, 'gpt-6-luna')).toBeUndefined();
  });
});
