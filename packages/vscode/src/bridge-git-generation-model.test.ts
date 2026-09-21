import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_ZEN_DEFAULT_MODEL, chooseBridgeGitGenerationModel } from './bridge-git-generation-model';

const catalogOf = (...refs: string[]) => {
  const set = new Set(refs);
  return (providerID: string, modelID: string) => set.has(`${providerID}/${modelID}`);
};

describe('chooseBridgeGitGenerationModel', () => {
  test('request payload model wins when it is in the catalog', () => {
    const choice = chooseBridgeGitGenerationModel(
      { providerId: 'anthropic', modelId: 'claude-sonnet-4' },
      { smallModelUseDefault: false, smallModelOverride: 'openai/gpt-4.1-mini' },
      catalogOf('anthropic/claude-sonnet-4', 'openai/gpt-4.1-mini'),
    );
    assert.deepEqual(choice, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  test('small-model override is honoured when present in the catalog', () => {
    const choice = chooseBridgeGitGenerationModel(
      {},
      { smallModelUseDefault: false, smallModelOverride: 'openai/gpt-4.1-mini' },
      catalogOf('openai/gpt-4.1-mini'),
    );
    assert.deepEqual(choice, { providerID: 'openai', modelID: 'gpt-4.1-mini' });
  });

  test('override model ids may contain slashes; only the first splits provider from model', () => {
    const choice = chooseBridgeGitGenerationModel(
      {},
      { smallModelUseDefault: false, smallModelOverride: 'openrouter/meta/llama-3' },
      catalogOf('openrouter/meta/llama-3'),
    );
    assert.deepEqual(choice, { providerID: 'openrouter', modelID: 'meta/llama-3' });
  });

  test('override is ignored when smallModelUseDefault is not false', () => {
    const hasModel = catalogOf('openai/gpt-4.1-mini');
    for (const useDefault of [true, undefined, 'false']) {
      const choice = chooseBridgeGitGenerationModel(
        {},
        { smallModelUseDefault: useDefault, smallModelOverride: 'openai/gpt-4.1-mini' },
        hasModel,
      );
      assert.deepEqual(choice, { providerID: 'zen', modelID: BRIDGE_ZEN_DEFAULT_MODEL });
    }
  });

  test('override is ignored when it is not in the catalog or malformed', () => {
    const hasModel = catalogOf('openai/gpt-4.1-mini');
    for (const override of ['openai/gpt-4o', 'openai', '/gpt-4.1-mini', 'openai/', '  ', 42]) {
      const choice = chooseBridgeGitGenerationModel(
        {},
        { smallModelUseDefault: false, smallModelOverride: override },
        hasModel,
      );
      assert.deepEqual(choice, { providerID: 'zen', modelID: BRIDGE_ZEN_DEFAULT_MODEL });
    }
  });

  test('the removed gitProviderId/gitModelId pair is no longer read', () => {
    const choice = chooseBridgeGitGenerationModel(
      {},
      { gitProviderId: 'openai', gitModelId: 'gpt-4.1-mini' },
      catalogOf('openai/gpt-4.1-mini'),
    );
    assert.deepEqual(choice, { providerID: 'zen', modelID: BRIDGE_ZEN_DEFAULT_MODEL });
  });

  test('zen fallback prefers the request zen model, then settings, then the default', () => {
    const none = () => false;
    assert.deepEqual(
      chooseBridgeGitGenerationModel({ zenModel: ' gpt-5-mini ' }, { zenModel: 'other' }, none),
      { providerID: 'zen', modelID: 'gpt-5-mini' },
    );
    assert.deepEqual(
      chooseBridgeGitGenerationModel({}, { zenModel: 'other' }, none),
      { providerID: 'zen', modelID: 'other' },
    );
    assert.deepEqual(
      chooseBridgeGitGenerationModel({}, {}, none),
      { providerID: 'zen', modelID: BRIDGE_ZEN_DEFAULT_MODEL },
    );
  });
});
