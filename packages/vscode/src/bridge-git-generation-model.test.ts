import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_ZEN_DEFAULT_MODEL,
  catalogModelRefsFromListPayload,
  chooseBridgeGitGenerationModel,
  pickCatalogGitGenerationFallback,
} from './bridge-git-generation-model';

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
      assert.deepEqual(choice, { providerID: 'opencode', modelID: 'big-pickle' });
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
      assert.deepEqual(choice, { providerID: 'opencode', modelID: 'big-pickle' });
    }
  });

  test('uses OpenCode big-pickle when zen is absent and no catalog fallback is given', () => {
    const none = () => false;
    assert.deepEqual(
      chooseBridgeGitGenerationModel({ zenModel: ' gpt-5-mini ' }, { zenModel: 'other' }, none),
      { providerID: 'opencode', modelID: 'big-pickle' },
    );
    assert.deepEqual(
      chooseBridgeGitGenerationModel({}, { zenModel: 'other' }, none),
      { providerID: 'opencode', modelID: 'big-pickle' },
    );
    assert.deepEqual(
      chooseBridgeGitGenerationModel({}, {}, none),
      { providerID: 'opencode', modelID: 'big-pickle' },
    );
  });

  test('uses a catalog model when zen is not in the catalog', () => {
    const fallback = { providerID: 'opencode', modelID: 'ling-3.0-flash-fin-free' };
    const choice = chooseBridgeGitGenerationModel(
      {},
      {},
      catalogOf('opencode/ling-3.0-flash-fin-free'),
      fallback,
    );
    assert.deepEqual(choice, fallback);
  });

  test('keeps zen when the catalog has it, even if a catalog fallback exists', () => {
    const choice = chooseBridgeGitGenerationModel(
      {},
      {},
      catalogOf(`zen/${BRIDGE_ZEN_DEFAULT_MODEL}`, 'opencode/ling-3.0-flash-fin-free'),
      { providerID: 'opencode', modelID: 'ling-3.0-flash-fin-free' },
    );
    assert.deepEqual(choice, { providerID: 'zen', modelID: BRIDGE_ZEN_DEFAULT_MODEL });
  });
});

describe('pickCatalogGitGenerationFallback', () => {
  test('prefers OpenCode big-pickle over other catalog rows', () => {
    assert.deepEqual(
      pickCatalogGitGenerationFallback([
        'anthropic/claude-sonnet-4',
        'opencode/deepseek-v4-flash-free',
        'opencode/ling-3.0-flash-fin-free',
        'opencode/big-pickle',
      ]),
      { providerID: 'opencode', modelID: 'big-pickle' },
    );
  });

  test('uses an OpenCode catalog row when big-pickle is absent', () => {
    assert.deepEqual(
      pickCatalogGitGenerationFallback([
        'anthropic/claude-sonnet-4',
        'opencode/ling-3.0-flash-fin-free',
      ]),
      { providerID: 'opencode', modelID: 'ling-3.0-flash-fin-free' },
    );
  });

  test('returns null for an empty catalog', () => {
    assert.equal(pickCatalogGitGenerationFallback([]), null);
  });
});

describe('catalogModelRefsFromListPayload', () => {
  test('reads the nested v2 { location, data } list used by the live SDK', () => {
    assert.deepEqual(
      catalogModelRefsFromListPayload({
        location: { directory: '/repo' },
        data: [
          { id: 'ling-3.0-flash-fin-free', providerID: 'opencode' },
          { id: 'claude-sonnet-4', providerID: 'anthropic' },
        ],
      }),
      ['opencode/ling-3.0-flash-fin-free', 'anthropic/claude-sonnet-4'],
    );
  });

  test('also accepts a bare model array from an unwrapped SDK list', () => {
    assert.deepEqual(
      catalogModelRefsFromListPayload([
        { id: 'big-pickle', providerID: 'opencode' },
      ]),
      ['opencode/big-pickle'],
    );
  });
});
